import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { RECORDER_STARTUP_GRACE_MS, STATUS_KEY } from "./constants.ts";
import {
	envFlag,
	getShortcut,
	getStreamFinalizeWithClip,
	getTerminalShortcut,
	getTranscriptionMode,
	reloadMicmeConfig,
	requireValidMicmeConfig,
} from "./config.ts";
import { buildRecorderCommand, listAudioDevices, prepareAudioForTranscription, registerDeviceMessageRenderer, validateRecordedAudio } from "./audio.ts";
import { installMicmeEditorFallback, type MicmeEditorInputHandlers } from "./editor.ts";
import { resolveTranscriptionPlan, formatTranscriptionPlan } from "./backends.ts";
import { ensureWhisperCppModel } from "./models.ts";
import {
	assertExpectedProcessExit,
	formatExit,
	formatProcessOutput,
	hasRecorderExited,
	normalizeTranscript,
	raceWithTimeout,
	spawnRecording,
	stopProcess,
	stopRecorder,
} from "./processes.ts";
import { RecordingWidget } from "./recording-widget.ts";
import { createRecordingDirectory, type RecordingDirectory } from "./recording-dir.ts";
import { showConfiguration } from "./settings.ts";
import {
	buildWhisperStreamCommand,
	clearStreamingFlush,
	drainStreamingOutput,
	flushPendingStreamingWords,
	getStreamingTranscript,
	handleStreamingOutput,
	pasteOrSubmitFinalStreamingTranscript,
	renderStreamingPreview,
	showStreamingDiagnostics,
} from "./streaming.ts";
import { pasteOrSubmitTranscript } from "./transcript-delivery.ts";
import { sanitizeTerminalOutput } from "./terminal-text.ts";
import { transcribe } from "./transcription.ts";
import type { CommandSpec, ExitResult, Recording, ResolvedTranscriptionPlan } from "./types.ts";

const MICME_ACTIONS = ["devices", "conf", "last", "audio", "help"] as const;
const SHORTCUT_REPEAT_GUARD_MS = 1_000;
const GUARDED_UI_METHODS = new Set(["notify", "pasteToEditor", "setEditorText", "setStatus", "setWidget"]);

type StreamingTranscriptionPlan = ResolvedTranscriptionPlan & { effectiveBackend: "whisper.cpp"; binary: string; modelPath: string };
type StreamingClipFailure = { error: unknown };
type StreamingClipPlan = { audioPath: string; command: CommandSpec } | StreamingClipFailure;
export type MicmeOperationPhase = "idle" | "starting" | "recording" | "streaming" | "stopping" | "transcribing" | "finalizing" | "shutting_down";

type MicmeOperation = {
	id: number;
	phase: Exclude<MicmeOperationPhase, "idle">;
	context: ExtensionContext;
	controller: AbortController;
	processes: Set<Recording>;
	directories: Set<RecordingDirectory>;
	keepAudio?: boolean;
	retainedStartupClipDirectory?: RecordingDirectory;
	completion?: Promise<void>;
	startupFailureCleanup?: Promise<unknown>;
};

class EarlyRecorderExitError extends Error {
	private readonly readStderr: Recording["stderr"];

	constructor(kind: "recorder" | "streaming", exit: ExitResult, recording: Recording) {
		super(`Micme ${kind} exited early (${formatExit(exit)}).`);
		this.readStderr = recording.stderr;
	}

	withDiagnostics() {
		const stderr = formatProcessOutput(this.readStderr());
		return new Error(stderr ? `${this.message}\n${stderr}` : this.message);
	}
}

export default function micmeExtension(pi: ExtensionAPI) {
	registerMicmeExtension(pi);
}

export function registerMicmeExtension(pi: ExtensionAPI) {
	const owner = new MicmeSessionOwner(pi);
	reloadMicmeConfig();
	registerDeviceMessageRenderer(pi);

	pi.registerCommand("micme", {
		description: "Toggle local voice recording and paste the transcript into the editor",
		getArgumentCompletions: getMicmeArgumentCompletions,
		handler: async (args, ctx) => handleMicmeCommand(owner, pi, args, ctx),
	});

	const terminalShortcut = getTerminalShortcut();
	if (terminalShortcut) {
		pi.registerShortcut(terminalShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Micme: toggle local voice recording",
			handler: async (ctx) => handleMicmeTerminalShortcut(owner, ctx),
		});
	}

	pi.on("session_start", async (_event, ctx) => owner.startSession(ctx));
	pi.on("session_shutdown", async (_event, ctx) => owner.shutdown(ctx));
	return owner;
}

export class MicmeSessionOwner {
	private readonly recordingWidget = new RecordingWidget();
	private readonly sessionController = new AbortController();
	private readonly sessionWork = new Set<Promise<void>>();
	private current: MicmeOperation | undefined;
	private closed = false;
	private nextOperationId = 1;
	private lastShortcutInputAt = 0;
	private lastTranscript = "";
	private lastAudioDir = "";
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	getPhase(): MicmeOperationPhase {
		if (this.closed) return "shutting_down";
		return this.current?.phase ?? "idle";
	}

	startSession(ctx: ExtensionContext) {
		reloadMicmeConfig();
		installMicmeEditorFallback(ctx, createMicmeEditorHandlers(this, ctx));
	}

	async toggle(ctx: ExtensionContext) {
		if (this.closed) return;
		const active = this.current;
		if (!active) {
			await this.start(ctx);
			return;
		}
		if (active.phase === "recording" || active.phase === "streaming") {
			await this.stop(active);
			return;
		}
		ctx.ui.notify(`Micme is ${formatOperationPhase(active.phase)}. Wait for it to finish before toggling again.`, "warning");
	}

	async handleTerminalShortcut(ctx: ExtensionContext) {
		if (this.isShortcutAutoRepeat()) return;
		await this.toggle(ctx);
	}

	async runSessionWork(ctx: ExtensionContext, work: (ctx: ExtensionContext, signal: AbortSignal) => Promise<void>) {
		const { signal } = this.sessionController;
		if (signal.aborted) return;
		const guardedContext = createGuardedContext(ctx, () => !signal.aborted);
		const pending = Promise.resolve().then(() => {
			if (!signal.aborted) return work(guardedContext, signal);
		});
		this.sessionWork.add(pending);
		try {
			await pending;
		} catch (error) {
			handleExtensionError(guardedContext, error);
		} finally {
			this.sessionWork.delete(pending);
		}
	}

	async shutdown(ctx: ExtensionContext) {
		if (this.closed) return;
		this.closed = true;
		const active = this.current;
		this.current = undefined;
		this.sessionController.abort();
		const pendingSessionWork = Promise.allSettled(this.sessionWork);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		this.recordingWidget.clear(ctx);
		if (!active) {
			await pendingSessionWork;
			return;
		}

		const phaseAtShutdown = active.phase;
		// One recorder can have failed while startup still awaits its companion's grace period.
		const failedBeforeShutdown = phaseAtShutdown === "starting" && [...active.processes].some(hasRecorderExited);
		const completion = active.completion?.catch(() => undefined);
		active.phase = "shutting_down";
		active.controller.abort();
		clearOperationTimers(active);
		await stopOwnedProcesses(active);
		if (phaseAtShutdown !== "starting" && completion) await raceWithTimeout(completion, 2_000);
		clearOperationTimers(active);
		await stopOwnedProcesses(active);
		// A failed start already owns the decision to keep or remove its audio.
		if (active.startupFailureCleanup) await active.startupFailureCleanup;
		else if (!failedBeforeShutdown || !inspectStartupClip(active)) await cleanupOwnedDirectories(this, active);
		// Late startup/finalization can still own a borrowed fd or be allocating a
		// directory. Do not recycle its descriptor while that work is in flight.
		if (completion) void completion.then(() => closeOwnedDirectories(active));
		else closeOwnedDirectories(active);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		this.recordingWidget.clear(ctx);
		await pendingSessionWork;
	}

	isCurrent(operation: MicmeOperation) {
		return !this.closed && this.current === operation;
	}

	transition(operation: MicmeOperation, phase: MicmeOperation["phase"]) {
		if (!this.isCurrent(operation)) return false;
		operation.phase = phase;
		return true;
	}

	activateRecording(operation: MicmeOperation, phase: "recording" | "streaming", primary: Recording, stopHint: string) {
		if (!this.transition(operation, phase)) return;
		// Detect the hook's exit independently of the supervisor and stdio drain.
		if (hasRecorderExited(primary)) {
			void this.stop(operation);
			return;
		}
		void primary.exitObserved.then(() => {
			if (this.isCurrent(operation) && operation.phase === phase) void this.stop(operation);
		});
		const ctx = operation.context;
		ctx.ui.setStatus(STATUS_KEY, `● ${phase} (${sanitizeTerminalOutput(stopHint) || "shortcut"} or /micme)`);
		this.recordingWidget.start(ctx, primary);
	}

	trackProcess(operation: MicmeOperation, active: Recording) {
		operation.processes.add(active);
	}

	async allocateRecordingDirectory(operation: MicmeOperation, tempPrefix: string) {
		const keepAudio = envFlag("MICME_KEEP_AUDIO");
		const directory = await createRecordingDirectory(operation.context.cwd, keepAudio, tempPrefix);
		operation.keepAudio = keepAudio;
		operation.directories.add(directory);
		return directory;
	}

	rememberTranscript(operation: MicmeOperation, transcript: string) {
		if (this.isCurrent(operation)) this.lastTranscript = transcript;
	}

	rememberAudioDirectory(operation: MicmeOperation, tempDir: string) {
		if (this.isCurrent(operation)) this.lastAudioDir = tempDir;
	}

	async pasteLastTranscript(ctx: ExtensionContext) {
		const active = this.current;
		// RPC has a write-only editor. Route replay through the same context that tracks live writes.
		const replayCtx = ctx.mode === "rpc" && active && firstMainRecording(active)?.streaming ? active.context : ctx;
		await pasteOrSubmitTranscript(replayCtx, this.pi, this.lastTranscript);
	}

	notifyLastAudioDirectory(ctx: ExtensionContext) {
		ctx.ui.notify(this.lastAudioDir ? `Last Micme audio directory: ${sanitizeTerminalOutput(this.lastAudioDir)}` : "No kept Micme audio yet. Set MICME_KEEP_AUDIO=1.", "info");
	}

	private async start(ctx: ExtensionContext) {
		requireValidMicmeConfig();
		const operation = this.beginOperation(ctx);
		const work = startRecording(this, operation, operation.context);
		operation.completion = work;
		try {
			await work;
		} catch (error) {
			if (!this.isCurrent(operation)) return;
			operation.startupFailureCleanup = this.cleanupFailedRecordingStart(operation, error);
			const reportedError = await operation.startupFailureCleanup;
			if (!this.isCurrent(operation)) return;
			handleExtensionError(operation.context, reportedError);
			this.finish(operation);
			closeOwnedDirectories(operation);
		} finally {
			if (operation.completion === work) operation.completion = undefined;
		}
	}

	private async cleanupFailedRecordingStart(operation: MicmeOperation, error: unknown) {
		this.recordingWidget.clear(operation.context);
		clearOperationTimers(operation);
		await stopOwnedProcesses(operation);
		// An observed hook exit can precede stderr drain; use the diagnostics available after stopping.
		const reportedError = error instanceof EarlyRecorderExitError ? error.withDiagnostics() : error;
		const retainedError = reportRetainedClip(this, operation, inspectStartupClip(operation), reportedError);
		if (retainedError) return retainedError;
		await cleanupOwnedDirectories(this, operation);
		return reportedError;
	}

	private async stop(operation: MicmeOperation) {
		if (!this.transition(operation, "stopping")) return;
		operation.context.ui.setStatus(STATUS_KEY, "stopping…");
		this.recordingWidget.clear(operation.context);
		const work = stopAndTranscribe(this, operation, this.pi);
		operation.completion = work;
		try {
			await work;
		} catch (error) {
			if (this.isCurrent(operation)) handleExtensionError(operation.context, error);
		} finally {
			if (operation.completion === work) operation.completion = undefined;
			if (this.isCurrent(operation)) {
				this.finish(operation);
				closeOwnedDirectories(operation);
			}
		}
	}

	private beginOperation(ctx: ExtensionContext) {
		const operation: MicmeOperation = {
			id: this.nextOperationId++,
			phase: "starting",
			context: ctx,
			controller: new AbortController(),
			processes: new Set(),
			directories: new Set(),
		};
		operation.context = createGuardedContext(ctx, () => this.isCurrent(operation));
		this.current = operation;
		ctx.ui.setStatus(STATUS_KEY, "starting…");
		return operation;
	}

	private finish(operation: MicmeOperation) {
		if (!this.isCurrent(operation)) return;
		this.current = undefined;
		operation.context.ui.setStatus(STATUS_KEY, undefined);
		this.recordingWidget.clear(operation.context);
	}

	private isShortcutAutoRepeat() {
		const now = Date.now();
		const repeated = now - this.lastShortcutInputAt < SHORTCUT_REPEAT_GUARD_MS;
		this.lastShortcutInputAt = now;
		return repeated;
	}
}

function getMicmeArgumentCompletions(prefix: string) {
	const matches = MICME_ACTIONS.filter((action) => action.startsWith(prefix.trim().toLowerCase()));
	return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

async function handleMicmeCommand(owner: MicmeSessionOwner, pi: ExtensionAPI, args: string, ctx: ExtensionContext) {
	const action = args.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	try {
		switch (action) {
			case "":
				await owner.toggle(ctx);
				return;
			case "devices":
				await owner.runSessionWork(ctx, async (sessionCtx, signal) => {
					requireValidMicmeConfig();
					await listAudioDevices(sessionCtx, pi, signal);
				});
				return;
			case "conf":
				await owner.runSessionWork(ctx, showConfiguration);
				return;
			case "last":
				await owner.pasteLastTranscript(ctx);
				return;
			case "audio":
				owner.notifyLastAudioDirectory(ctx);
				return;
			case "help":
				ctx.ui.notify(getHelpText(), "info");
				return;
			default:
				ctx.ui.notify(`Unknown micme action: ${sanitizeTerminalOutput(action) || "(empty)"}. Try /micme help`, "warning");
		}
	} catch (error) {
		handleExtensionError(ctx, error);
	}
}

async function handleMicmeTerminalShortcut(owner: MicmeSessionOwner, ctx: ExtensionContext) {
	try {
		await owner.handleTerminalShortcut(ctx);
	} catch (error) {
		handleExtensionError(ctx, error);
	}
}

function createMicmeEditorHandlers(owner: MicmeSessionOwner, ctx: ExtensionContext): MicmeEditorInputHandlers {
	return {
		toggle: () => owner.toggle(ctx).catch((error) => handleExtensionError(ctx, error)),
	};
}

function handleExtensionError(ctx: ExtensionContext, error: unknown) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(sanitizeTerminalOutput(error instanceof Error ? error.message : String(error)) || "Micme failed with an empty error message.", "error");
}

function formatOperationPhase(phase: MicmeOperation["phase"]) {
	return phase.replaceAll("_", " ");
}

function getHelpText() {
	const shortcut = sanitizeTerminalOutput(getShortcut()) || "not set";
	const actions = MICME_ACTIONS.filter((action) => action !== "help").join("|");
	return `Usage: /micme [${actions}]. Shortcut: ${shortcut} toggles recording; tap once to start, tap again to stop/transcribe. Toggles are rejected while Micme is starting, stopping, transcribing, or finalizing.`;
}

async function startRecording(owner: MicmeSessionOwner, operation: MicmeOperation, ctx: ExtensionContext, stopHint = getShortcut()) {
	if (getTranscriptionMode() === "stream") {
		await startStreamingTranscription(owner, operation, ctx, stopHint);
		return;
	}
	await startClipRecording(owner, operation, ctx, stopHint);
}

async function startClipRecording(owner: MicmeSessionOwner, operation: MicmeOperation, ctx: ExtensionContext, stopHint: string) {
	const directory = await owner.allocateRecordingDirectory(operation, "micme-");
	if (!owner.isCurrent(operation)) {
		await cleanupRecordingDirectory(owner, operation, directory);
		return;
	}

	const audioPath = join(directory.filesPath, "raw.wav");
	const command = await buildRecorderCommand(audioPath, directory.filesPath, operation.controller.signal);
	if (!owner.isCurrent(operation)) return;
	const active = spawnRecording(command, audioPath, directory.path, directory);
	owner.trackProcess(operation, active);
	const earlyExit = await raceWithTimeout(active.exitObserved, RECORDER_STARTUP_GRACE_MS);
	if (!owner.isCurrent(operation)) return;
	if (earlyExit) throw new EarlyRecorderExitError("recorder", earlyExit, active);

	owner.activateRecording(operation, "recording", active, stopHint);
}

async function startStreamingTranscription(owner: MicmeSessionOwner, operation: MicmeOperation, ctx: ExtensionContext, stopHint: string) {
	const plan = resolveStreamingTranscriptionPlan();
	await ensureWhisperCppModel(plan.modelPath, ctx, { allowDownload: plan.modelDownloadable !== false, signal: operation.controller.signal });
	if (!owner.isCurrent(operation)) return;

	const directory = await owner.allocateRecordingDirectory(operation, "micme-stream-");
	if (!owner.isCurrent(operation)) {
		await cleanupRecordingDirectory(owner, operation, directory);
		return;
	}

	const clipPlan = getStreamFinalizeWithClip() ? await prepareStreamingClip(operation, directory) : undefined;
	if (!owner.isCurrent(operation)) return;
	const streamRecording = spawnWhisperStreamingRecording(plan, directory.path);
	owner.trackProcess(operation, streamRecording);
	initializeStreamingRecording(ctx, streamRecording);
	const [earlyExit, clipFailure] = await Promise.all([
		raceWithTimeout(streamRecording.exitObserved, RECORDER_STARTUP_GRACE_MS),
		startStreamingClip(owner, operation, streamRecording, directory, clipPlan),
	]);
	if (!owner.isCurrent(operation)) return;
	if (earlyExit) throw new EarlyRecorderExitError("streaming", earlyExit, streamRecording);
	if (clipFailure) await fallBackFromStreamingClipStart(owner, operation, streamRecording, clipFailure.error);
	owner.activateRecording(operation, "streaming", streamRecording, stopHint);
}

function resolveStreamingTranscriptionPlan(): StreamingTranscriptionPlan {
	const plan = resolveTranscriptionPlan({ transcriptionMode: "stream" });
	if (plan.effectiveBackend !== "whisper.cpp" || !plan.binary || !plan.modelPath) {
		throw new Error(formatTranscriptionPlan(plan));
	}
	return plan as StreamingTranscriptionPlan;
}

function spawnWhisperStreamingRecording(plan: StreamingTranscriptionPlan, tempDir: string) {
	const command = buildWhisperStreamCommand(plan.binary, plan.modelPath, tempDir);
	return spawnRecording(command, "", tempDir);
}

function initializeStreamingRecording(ctx: ExtensionContext, streamRecording: Recording) {
	streamRecording.streaming = {
		baseText: ctx.ui.getEditorText(),
		renderedWordCount: 0,
		outputBuffer: "",
		lastText: "",
		emittedWords: [],
		candidateWords: [],
		lastHypothesisWords: [],
		startedAt: Date.now(),
	};
	streamRecording.process.stdout?.on("data", (chunk: Buffer | string) => {
		// Draining pipes after a spontaneous exit must not restart the live preview timer.
		if (!streamRecording.stopRequested && hasRecorderExited(streamRecording)) return;
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		handleStreamingOutput(ctx, streamRecording, text);
	});
}

async function prepareStreamingClip(operation: MicmeOperation, directory: RecordingDirectory): Promise<StreamingClipPlan> {
	const audioPath = join(directory.filesPath, "raw.wav");
	try {
		const command = await buildRecorderCommand(audioPath, directory.filesPath, operation.controller.signal);
		return { audioPath, command };
	} catch (error) {
		return { error };
	}
}

async function startStreamingClip(
	owner: MicmeSessionOwner,
	operation: MicmeOperation,
	streamRecording: Recording,
	directory: RecordingDirectory,
	plan: StreamingClipPlan | undefined,
): Promise<StreamingClipFailure | undefined> {
	if (!plan || "error" in plan) return plan;
	try {
		const clip = spawnRecording(plan.command, plan.audioPath, directory.path, directory);
		streamRecording.clipRecording = clip;
		owner.trackProcess(operation, clip);
		const earlyExit = await raceWithTimeout(clip.exitObserved, RECORDER_STARTUP_GRACE_MS);
		if (earlyExit) return { error: new EarlyRecorderExitError("recorder", earlyExit, clip) };
	} catch (error) {
		return { error };
	}
}

async function fallBackFromStreamingClipStart(owner: MicmeSessionOwner, operation: MicmeOperation, streamRecording: Recording, error: unknown) {
	const clip = streamRecording.clipRecording;
	// Stop only the companion and drain its diagnostics before inspecting partial audio.
	const stopFailure = clip ? await stopProcess(clip).then(() => undefined, (error: unknown) => ({ error })) : undefined;
	if (!owner.isCurrent(operation)) return;
	if (hasRecorderExited(streamRecording)) throw new EarlyRecorderExitError("streaming", streamRecording.getExit(), streamRecording);

	// Detach the unusable clip so stopping the stream takes the existing live-only path.
	streamRecording.clipRecording = undefined;
	const retained = stopFailure && clip?.directory
		? { note: "Audio may remain in", path: clip.directory.path }
		: inspectPartialClip(clip, 1);
	if (retained) operation.retainedStartupClipDirectory = clip?.directory;
	const startupError = error instanceof EarlyRecorderExitError ? error.withDiagnostics() : error;
	const details = [startupError, ...(stopFailure ? [stopFailure.error] : [])]
		.map((failure) => failure instanceof Error ? failure.message : String(failure)).join("\n");
	const reportedError = reportRetainedClip(owner, operation, retained, details);
	const message = sanitizeTerminalOutput(reportedError?.message ?? details) || "unknown error";
	operation.context.ui.notify(`Micme will use the live append-only stream transcript because the final clip recorder could not start: ${message}`, "warning");
}

async function stopAndTranscribe(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI) {
	const active = firstMainRecording(operation);
	if (!active) throw new Error("Micme lost ownership of its recording process.");
	if (active.streaming) {
		await stopStreamingTranscription(owner, operation, pi, active, active.streaming);
		return;
	}
	await stopClipAndTranscribe(owner, operation, pi, active);
}

function firstMainRecording(operation: MicmeOperation) {
	return operation.processes.values().next().value;
}

async function stopClipAndTranscribe(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI, active: Recording) {
	const ctx = operation.context;
	let transcript: string;
	try {
		await stopRecorder(active);
		if (!owner.isCurrent(operation)) return;
		owner.transition(operation, "transcribing");
		ctx.ui.setStatus(STATUS_KEY, "transcribing…");
		const rawTranscript = await transcribeRecordingClip(owner, operation, active);
		if (!owner.isCurrent(operation)) return;
		transcript = normalizeTranscript(rawTranscript);
		if (!transcript) throw new Error("Micme did not receive any transcript text.");
	} catch (error) {
		if (!owner.isCurrent(operation)) return;
		owner.rememberAudioDirectory(operation, active.tempDir);
		const message = sanitizeTerminalOutput(error instanceof Error ? error.message : String(error));
		throw new Error(`${message}\nAudio kept for debugging: ${sanitizeTerminalOutput(active.tempDir)}`, { cause: error });
	}

	await deliverTranscribedClip(owner, operation, pi, active.tempDir, transcript);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function stopStreamingTranscription(
	owner: MicmeSessionOwner,
	operation: MicmeOperation,
	pi: ExtensionAPI,
	active: Recording,
	state: NonNullable<Recording["streaming"]>,
) {
	const ctx = operation.context;
	const clipStopPromise = stopClipRecording(active);
	prepareStreamingStop(ctx, active, state);
	const exit = await stopProcess(active);
	if (!owner.isCurrent(operation)) return;
	try {
		assertExpectedProcessExit(active, exit, "stream");
	} catch (error) {
		await clipStopPromise;
		if (!owner.isCurrent(operation)) return;
		const retainedError = reportRetainedClip(owner, operation, inspectPartialClip(active.clipRecording), error);
		if (retainedError) throw retainedError;
		await cleanupOwnedDirectories(owner, operation);
		throw error;
	}

	owner.transition(operation, "finalizing");
	ctx.ui.setStatus(STATUS_KEY, "finalizing stream…");
	await completeStreamingStop(owner, operation, pi, active, state, clipStopPromise);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function inspectStartupClip(operation: MicmeOperation) {
	const clip = [...operation.processes].find((recording) => recording.directory);
	return inspectPartialClip(clip, 1);
}

function inspectPartialClip(clip: Recording | undefined, minBytes = 0) {
	if (!clip?.directory) return;
	let note = "Audio kept for debugging";
	try {
		if (!clip.directory.hasRegularFile(clip.audioPath, minBytes)) return;
	} catch {
		// Failed inspection is not proof that the directory is safe to delete.
		note = "Audio may remain in";
	}
	return { note, path: clip.directory.path };
}

function reportRetainedClip(owner: MicmeSessionOwner, operation: MicmeOperation, retained: ReturnType<typeof inspectPartialClip>, error: unknown) {
	if (!retained) return;
	owner.rememberAudioDirectory(operation, retained.path);
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${message}\n${retained.note}: ${retained.path}`, { cause: error });
}

function stopClipRecording(active: Recording) {
	return active.clipRecording ? stopRecorder(active.clipRecording).then(() => undefined, (error: unknown) => error) : undefined;
}

async function validateAudioForTranscription(ctx: ExtensionContext, audioPath: string, signal: AbortSignal, cwdFd?: number) {
	const outcome = await validateRecordedAudio(audioPath, signal, cwdFd);
	if (outcome.status !== "skipped" || outcome.reason !== "ffmpeg-unavailable") return;
	ctx.ui.notify("Micme skipped silence validation because ffmpeg was not found. Install ffmpeg or set MICME_VALIDATE_AUDIO=0 to disable the silence guard.", "warning");
}

function prepareStreamingStop(ctx: ExtensionContext, active: Recording, state: NonNullable<Recording["streaming"]>) {
	drainStreamingOutput(ctx, active, false);
	renderStreamingPreview(ctx, state, false);
	clearStreamingFlush(state);
}

async function completeStreamingStop(
	owner: MicmeSessionOwner,
	operation: MicmeOperation,
	pi: ExtensionAPI,
	active: Recording,
	state: NonNullable<Recording["streaming"]>,
	clipStopPromise: ReturnType<typeof stopClipRecording>,
) {
	const ctx = operation.context;
	drainStreamingOutput(ctx, active, true);
	showStreamingDiagnostics(ctx, state);
	const clipRecording = active.clipRecording;
	if (!clipRecording) {
		await useLiveStreamingTranscript(owner, operation, pi, state);
		clearStreamingFlush(state);
		if (owner.isCurrent(operation)) await cleanupOwnedDirectories(owner, operation);
		return;
	}

	renderStreamingPreview(ctx, state, false);
	clearStreamingFlush(state);
	await finalizeStreamingClip(owner, operation, pi, active, clipRecording, state, clipStopPromise);
}

async function useLiveStreamingTranscript(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI, state: NonNullable<Recording["streaming"]>) {
	const ctx = operation.context;
	flushPendingStreamingWords(ctx, state);
	const liveTranscript = normalizeTranscript(getStreamingTranscript(state));
	if (!owner.isCurrent(operation)) return;
	if (!liveTranscript) {
		ctx.ui.notify("Micme did not recognize any words in the live stream.", "warning");
		return;
	}

	owner.rememberTranscript(operation, liveTranscript);
	if (!envFlag("MICME_AUTO_SUBMIT")) return;
	ctx.ui.setEditorText(state.baseText);
	if (!owner.isCurrent(operation)) return;
	await pasteOrSubmitTranscript(ctx, pi, liveTranscript);
}

async function finalizeStreamingClip(
	owner: MicmeSessionOwner,
	operation: MicmeOperation,
	pi: ExtensionAPI,
	active: Recording,
	clipRecording: Recording,
	state: NonNullable<Recording["streaming"]>,
	clipStopPromise: ReturnType<typeof stopClipRecording>,
) {
	let transcript: string;
	try {
		const clipStopError = await clipStopPromise;
		if (!owner.isCurrent(operation)) return;
		if (clipStopError) throw clipStopError;
		const rawTranscript = await transcribeRecordingClip(owner, operation, clipRecording);
		if (!owner.isCurrent(operation)) return;
		transcript = normalizeTranscript(rawTranscript);
		if (!transcript) throw new Error("Micme did not receive any final transcript text.");
	} catch (error) {
		if (owner.isCurrent(operation)) handleFinalStreamingClipError(owner, operation, active, state, error);
		return;
	}

	await deliverTranscribedClip(owner, operation, pi, active.tempDir, transcript, state);
}

async function transcribeRecordingClip(owner: MicmeSessionOwner, operation: MicmeOperation, recording: Recording) {
	requireValidMicmeConfig();
	const { audioPath, directory, tempDir } = recording;
	const ctx = operation.context;
	const filesPath = directory?.filesPath ?? tempDir;
	const signal = operation.controller.signal;
	const preparedAudioPath = await prepareAudioForTranscription(audioPath, filesPath, signal, directory?.cwdFd);
	if (!owner.isCurrent(operation)) return "";
	await validateAudioForTranscription(ctx, preparedAudioPath, signal, directory?.cwdFd);
	if (!owner.isCurrent(operation)) return "";
	return transcribe(preparedAudioPath, filesPath, ctx, signal, directory);
}

async function deliverTranscribedClip(
	owner: MicmeSessionOwner,
	operation: MicmeOperation,
	pi: ExtensionAPI,
	tempDir: string,
	transcript: string,
	streaming?: NonNullable<Recording["streaming"]>,
) {
	const ctx = operation.context;
	owner.rememberTranscript(operation, transcript);
	try {
		if (streaming) await pasteOrSubmitFinalStreamingTranscript(ctx, pi, streaming, transcript);
		else await pasteOrSubmitTranscript(ctx, pi, transcript);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Micme could not deliver the transcript: ${message}`, { cause: error });
	} finally {
		if (owner.isCurrent(operation)) {
			if (operation.keepAudio) owner.rememberAudioDirectory(operation, tempDir);
			else await cleanupOwnedDirectories(owner, operation);
		}
	}
}

function handleFinalStreamingClipError(
	owner: MicmeSessionOwner,
	operation: MicmeOperation,
	active: Recording,
	state: NonNullable<Recording["streaming"]>,
	error: unknown,
) {
	const ctx = operation.context;
	flushPendingStreamingWords(ctx, state);
	const liveTranscript = normalizeTranscript(getStreamingTranscript(state));
	if (liveTranscript) owner.rememberTranscript(operation, liveTranscript);
	owner.rememberAudioDirectory(operation, active.tempDir);
	const message = sanitizeTerminalOutput(error instanceof Error ? error.message : String(error));
	ctx.ui.notify(`Micme kept the live append-only stream transcript because final clip transcription failed: ${message}\nAudio kept for debugging: ${sanitizeTerminalOutput(active.tempDir)}`, "warning");
}

function clearOperationTimers(operation: MicmeOperation) {
	for (const active of operation.processes) {
		if (active.streaming) clearStreamingFlush(active.streaming);
	}
}

async function stopOwnedProcesses(operation: MicmeOperation) {
	await Promise.all([...operation.processes].map((active) => stopProcess(active).catch(() => undefined)));
}

function closeOwnedDirectories(operation: MicmeOperation) {
	for (const directory of operation.directories) directory.close();
	operation.directories.clear();
}

async function cleanupOwnedDirectories(owner: MicmeSessionOwner, operation: MicmeOperation) {
	const removable = [...operation.directories].filter((directory) => directory !== operation.retainedStartupClipDirectory);
	await Promise.all(removable.map((directory) => cleanupRecordingDirectory(owner, operation, directory)));
}

async function cleanupRecordingDirectory(owner: MicmeSessionOwner, operation: MicmeOperation, directory: RecordingDirectory) {
	try {
		await directory.remove();
	} catch (error) {
		if (!owner.isCurrent(operation)) return;
		owner.rememberAudioDirectory(operation, directory.path);
		const message = sanitizeTerminalOutput(error instanceof Error ? error.message : String(error)) || "unknown error";
		operation.context.ui.notify(`Micme could not clean up the recording directory: ${message}\nAudio may remain in: ${sanitizeTerminalOutput(directory.path)}`, "warning");
	}
}

function createGuardedContext(ctx: ExtensionContext, isCurrent: () => boolean) {
	let lastRpcEditorText: string | undefined;
	const guardedUi = new Proxy(ctx.ui, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			if (ctx.mode === "rpc" && property === "getEditorText") return () => lastRpcEditorText ?? ctx.ui.getEditorText();
			if (!GUARDED_UI_METHODS.has(String(property))) return value.bind(target);
			return (...args: unknown[]) => {
				if (!isCurrent()) return undefined;
				const result: unknown = Reflect.apply(value, target, args);
				// Pi RPC implements both of these as set_editor_text; getEditorText() always returns "".
				if (ctx.mode === "rpc" && (property === "setEditorText" || property === "pasteToEditor") && typeof args[0] === "string") lastRpcEditorText = args[0];
				return result;
			};
		},
	});
	return new Proxy(ctx, {
		get(target, property, receiver) {
			if (property === "ui") return guardedUi;
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExtensionContext;
}
