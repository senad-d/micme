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
	cleanup,
	formatExit,
	formatProcessOutput,
	normalizeTranscript,
	raceWithTimeout,
	spawnRecording,
	stopProcess,
	stopRecorder,
} from "./processes.ts";
import { clearRecordingWidget, startRecordingWidget } from "./recording-widget.ts";
import { createRecordingDirectory } from "./recording-dir.ts";
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
import type { Recording, ResolvedTranscriptionPlan } from "./types.ts";

const MICME_ACTIONS = ["devices", "conf", "last", "audio", "help"] as const;
const SHORTCUT_REPEAT_GUARD_MS = 1_000;
const GUARDED_UI_METHODS = new Set(["notify", "pasteToEditor", "setEditorText", "setStatus", "setWidget"]);

type StreamingTranscriptionPlan = ResolvedTranscriptionPlan & { effectiveBackend: "whisper.cpp"; binary: string; modelPath: string };
export type MicmeOperationPhase = "idle" | "starting" | "recording" | "streaming" | "stopping" | "transcribing" | "finalizing" | "shutting_down";

type MicmeOperation = {
	id: number;
	phase: Exclude<MicmeOperationPhase, "idle">;
	context: ExtensionContext;
	controller: AbortController;
	processes: Set<Recording>;
	tempDirs: Set<string>;
	completion?: Promise<void>;
};

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

	async shutdown(ctx: ExtensionContext) {
		if (this.closed) return;
		this.closed = true;
		const active = this.current;
		this.current = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearRecordingWidget(ctx);
		if (!active) return;

		const phaseAtShutdown = active.phase;
		active.phase = "shutting_down";
		active.controller.abort();
		clearOperationTimers(active);
		await stopOwnedProcesses(active);
		if (phaseAtShutdown !== "starting" && active.completion) {
			await raceWithTimeout(active.completion.catch(() => undefined), 2_000);
		}
		clearOperationTimers(active);
		await stopOwnedProcesses(active);
		await cleanupOwnedDirectories(active);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearRecordingWidget(ctx);
	}

	isCurrent(operation: MicmeOperation) {
		return !this.closed && this.current === operation;
	}

	transition(operation: MicmeOperation, phase: MicmeOperation["phase"]) {
		if (!this.isCurrent(operation)) return false;
		operation.phase = phase;
		return true;
	}

	trackProcess(operation: MicmeOperation, active: Recording) {
		operation.processes.add(active);
	}

	trackDirectory(operation: MicmeOperation, tempDir: string) {
		operation.tempDirs.add(tempDir);
	}

	rememberTranscript(operation: MicmeOperation, transcript: string) {
		if (this.isCurrent(operation)) this.lastTranscript = transcript;
	}

	rememberAudioDirectory(operation: MicmeOperation, tempDir: string) {
		if (this.isCurrent(operation)) this.lastAudioDir = tempDir;
	}

	async pasteLastTranscript(ctx: ExtensionContext) {
		await pasteOrSubmitTranscript(ctx, this.pi, this.lastTranscript);
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
			handleExtensionError(operation.context, error);
			this.finish(operation);
		} finally {
			if (operation.completion === work) operation.completion = undefined;
		}
	}

	private async stop(operation: MicmeOperation) {
		if (!this.transition(operation, "stopping")) return;
		operation.context.ui.setStatus(STATUS_KEY, "stopping…");
		clearRecordingWidget(operation.context);
		const work = stopAndTranscribe(this, operation, this.pi);
		operation.completion = work;
		try {
			await work;
		} catch (error) {
			if (this.isCurrent(operation)) handleExtensionError(operation.context, error);
		} finally {
			if (operation.completion === work) operation.completion = undefined;
			if (this.isCurrent(operation)) this.finish(operation);
		}
	}

	private beginOperation(ctx: ExtensionContext) {
		const operation: MicmeOperation = {
			id: this.nextOperationId++,
			phase: "starting",
			context: ctx,
			controller: new AbortController(),
			processes: new Set(),
			tempDirs: new Set(),
		};
		operation.context = createGuardedContext(this, operation, ctx);
		this.current = operation;
		ctx.ui.setStatus(STATUS_KEY, "starting…");
		return operation;
	}

	private finish(operation: MicmeOperation) {
		if (!this.isCurrent(operation)) return;
		this.current = undefined;
		operation.context.ui.setStatus(STATUS_KEY, undefined);
		clearRecordingWidget(operation.context);
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
				requireValidMicmeConfig();
				await listAudioDevices(ctx, pi);
				return;
			case "conf":
				await showConfiguration(ctx);
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
	const tempDir = await createRecordingDirectory(ctx.cwd, envFlag("MICME_KEEP_AUDIO"), "micme-");
	owner.trackDirectory(operation, tempDir);
	if (!owner.isCurrent(operation)) {
		await cleanup(tempDir).catch(() => undefined);
		return;
	}

	try {
		const audioPath = join(tempDir, "raw.wav");
		const active = spawnRecording(buildRecorderCommand(audioPath), audioPath, tempDir);
		owner.trackProcess(operation, active);
		const earlyExit = await raceWithTimeout(active.exitPromise, RECORDER_STARTUP_GRACE_MS);
		if (!owner.isCurrent(operation)) return;
		if (earlyExit) {
			const stderr = formatProcessOutput(active.stderr());
			const suffix = stderr ? `\n${stderr}` : "";
			throw new Error(`Micme recorder exited early (${formatExit(earlyExit)}).${suffix}`);
		}

		owner.transition(operation, "recording");
		ctx.ui.setStatus(STATUS_KEY, `● recording (${sanitizeTerminalOutput(stopHint) || "shortcut"} or /micme)`);
		startRecordingWidget(ctx, active);
	} catch (error) {
		await cleanupFailedRecordingStart(ctx, operation);
		throw error;
	}
}

async function startStreamingTranscription(owner: MicmeSessionOwner, operation: MicmeOperation, ctx: ExtensionContext, stopHint: string) {
	const plan = resolveStreamingTranscriptionPlan();
	await ensureWhisperCppModel(plan.modelPath, ctx, { allowDownload: plan.modelDownloadable !== false, signal: operation.controller.signal });
	if (!owner.isCurrent(operation)) return;

	const tempDir = await createRecordingDirectory(ctx.cwd, envFlag("MICME_KEEP_AUDIO"), "micme-stream-");
	owner.trackDirectory(operation, tempDir);
	if (!owner.isCurrent(operation)) {
		await cleanup(tempDir).catch(() => undefined);
		return;
	}

	try {
		const streamRecording = spawnWhisperStreamingRecording(plan, tempDir);
		owner.trackProcess(operation, streamRecording);
		initializeStreamingRecording(ctx, streamRecording);
		const clipRecording = startOptionalClipRecording(streamRecording, tempDir);
		if (clipRecording) owner.trackProcess(operation, clipRecording);

		await ensureStreamingRecorderStarted(streamRecording);
		if (!owner.isCurrent(operation)) return;
		owner.transition(operation, "streaming");
		ctx.ui.setStatus(STATUS_KEY, `● streaming (${sanitizeTerminalOutput(stopHint) || "shortcut"} or /micme)`);
		startRecordingWidget(ctx, streamRecording);
	} catch (error) {
		await cleanupFailedRecordingStart(ctx, operation);
		throw error;
	}
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
	const baseText = ctx.ui.getEditorText();
	streamRecording.streaming = {
		baseText,
		previewText: baseText,
		outputBuffer: "",
		lastText: "",
		emittedWords: [],
		candidateWords: [],
		lastHypothesisWords: [],
		startedAt: Date.now(),
	};
	streamRecording.process.stdout?.on("data", (chunk: Buffer | string) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		handleStreamingOutput(ctx, streamRecording, text);
	});
}

function startOptionalClipRecording(streamRecording: Recording, tempDir: string) {
	const clipAudioPath = getStreamFinalizeWithClip() ? join(tempDir, "raw.wav") : undefined;
	if (!clipAudioPath) return undefined;
	const clipRecording = spawnRecording(buildRecorderCommand(clipAudioPath), clipAudioPath, tempDir);
	streamRecording.clipRecording = clipRecording;
	return clipRecording;
}

async function ensureStreamingRecorderStarted(streamRecording: Recording) {
	const [earlyExit, recorderEarlyExit] = await Promise.all([
		raceWithTimeout(streamRecording.exitPromise, RECORDER_STARTUP_GRACE_MS),
		streamRecording.clipRecording ? raceWithTimeout(streamRecording.clipRecording.exitPromise, RECORDER_STARTUP_GRACE_MS) : Promise.resolve(undefined),
	]);
	const failedExit = earlyExit ?? recorderEarlyExit;
	if (!failedExit) return;
	if (streamRecording.stopRequested || streamRecording.clipRecording?.stopRequested) return;
	const failed = earlyExit ? streamRecording : streamRecording.clipRecording;
	const stderr = failed ? formatProcessOutput(failed.stderr()) : "";
	const suffix = stderr ? `\n${stderr}` : "";
	throw new Error(`Micme streaming exited early (${formatExit(failedExit)}).${suffix}`);
}

async function cleanupFailedRecordingStart(ctx: ExtensionContext, operation: MicmeOperation) {
	clearRecordingWidget(ctx);
	clearOperationTimers(operation);
	await stopOwnedProcesses(operation);
	await cleanupOwnedDirectories(operation);
}

async function stopAndTranscribe(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI) {
	const active = firstMainRecording(operation);
	if (!active) throw new Error("Micme lost ownership of its recording process.");
	if (active.streaming) {
		await stopStreamingTranscription(owner, operation, pi, active);
		return;
	}
	await stopClipAndTranscribe(owner, operation, pi, active);
}

function firstMainRecording(operation: MicmeOperation) {
	return operation.processes.values().next().value;
}

async function stopClipAndTranscribe(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI, active: Recording) {
	const ctx = operation.context;
	let completed = false;
	try {
		await stopRecorder(active);
		if (!owner.isCurrent(operation)) return;
		owner.transition(operation, "transcribing");
		ctx.ui.setStatus(STATUS_KEY, "transcribing…");
		const preparedAudioPath = await prepareAudioForTranscription(active.audioPath, active.tempDir, operation.controller.signal);
		if (!owner.isCurrent(operation)) return;
		await validateAudioForTranscription(ctx, preparedAudioPath, operation.controller.signal);
		if (!owner.isCurrent(operation)) return;
		const transcript = await transcribe(preparedAudioPath, active.tempDir, ctx, operation.controller.signal);
		if (!owner.isCurrent(operation)) return;
		const normalized = normalizeTranscript(transcript);
		if (!normalized) throw new Error("Micme did not receive any transcript text.");

		owner.rememberTranscript(operation, normalized);
		await pasteOrSubmitTranscript(ctx, pi, normalized);
		if (!owner.isCurrent(operation)) return;
		completed = true;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (envFlag("MICME_KEEP_AUDIO")) owner.rememberAudioDirectory(operation, active.tempDir);
	} catch (error) {
		if (!owner.isCurrent(operation)) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		owner.rememberAudioDirectory(operation, active.tempDir);
		const message = sanitizeTerminalOutput(error instanceof Error ? error.message : String(error));
		throw new Error(`${message}\nAudio kept for debugging: ${sanitizeTerminalOutput(active.tempDir)}`, { cause: error });
	} finally {
		if (completed && !envFlag("MICME_KEEP_AUDIO")) await cleanup(active.tempDir).catch(() => undefined);
	}
}

async function stopStreamingTranscription(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI, active: Recording) {
	const ctx = operation.context;
	const state = active.streaming;
	const clipStopPromise = stopClipRecording(active);
	prepareStreamingStop(ctx, active, state);
	const exit = await stopProcess(active);
	if (!owner.isCurrent(operation)) return;
	try {
		assertExpectedProcessExit(active, exit, "stream");
	} catch (error) {
		if (clipStopPromise) await clipStopPromise;
		throw error;
	}

	owner.transition(operation, "finalizing");
	ctx.ui.setStatus(STATUS_KEY, "finalizing stream…");
	const keepTempDir = state ? await completeStreamingStop(owner, operation, pi, active, state, clipStopPromise) : false;
	if (!owner.isCurrent(operation)) return;
	if (!keepTempDir) await cleanup(active.tempDir).catch(() => undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function stopClipRecording(active: Recording) {
	return active.clipRecording ? stopRecorder(active.clipRecording).then(() => undefined, (error: unknown) => error) : undefined;
}

async function validateAudioForTranscription(ctx: ExtensionContext, audioPath: string, signal: AbortSignal) {
	const outcome = await validateRecordedAudio(audioPath, signal);
	if (outcome.status !== "skipped" || outcome.reason !== "ffmpeg-unavailable") return;
	ctx.ui.notify("Micme skipped silence validation because ffmpeg was not found. Install ffmpeg or set MICME_VALIDATE_AUDIO=0 to disable the silence guard.", "warning");
}

function prepareStreamingStop(ctx: ExtensionContext, active: Recording, state: Recording["streaming"]) {
	if (!state) return;
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
		return false;
	}

	renderStreamingPreview(ctx, state, false);
	clearStreamingFlush(state);
	return finalizeStreamingClip(owner, operation, pi, active, clipRecording, state, clipStopPromise);
}

async function useLiveStreamingTranscript(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI, state: NonNullable<Recording["streaming"]>) {
	const ctx = operation.context;
	flushPendingStreamingWords(ctx, state);
	const liveTranscript = normalizeTranscript(getStreamingTranscript(state));
	if (!liveTranscript || !owner.isCurrent(operation)) return;

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
	try {
		await transcribeFinalStreamingClip(owner, operation, pi, active, clipRecording, state, clipStopPromise);
		return keepCompletedStreamingClipAudio(owner, operation, active);
	} catch (error) {
		if (!owner.isCurrent(operation)) return false;
		handleFinalStreamingClipError(owner, operation, active, state, error);
		return true;
	}
}

async function transcribeFinalStreamingClip(
	owner: MicmeSessionOwner,
	operation: MicmeOperation,
	pi: ExtensionAPI,
	active: Recording,
	clipRecording: Recording,
	state: NonNullable<Recording["streaming"]>,
	clipStopPromise: ReturnType<typeof stopClipRecording>,
) {
	const ctx = operation.context;
	const clipStopError = clipStopPromise ? await clipStopPromise : undefined;
	if (!owner.isCurrent(operation)) return;
	if (clipStopError) throw clipStopError;
	const preparedAudioPath = await prepareAudioForTranscription(clipRecording.audioPath, active.tempDir, operation.controller.signal);
	if (!owner.isCurrent(operation)) return;
	await validateAudioForTranscription(ctx, preparedAudioPath, operation.controller.signal);
	if (!owner.isCurrent(operation)) return;
	const transcript = await transcribe(preparedAudioPath, active.tempDir, ctx, operation.controller.signal);
	if (!owner.isCurrent(operation)) return;
	const normalized = normalizeTranscript(transcript);
	if (!normalized) throw new Error("Micme did not receive any final transcript text.");

	owner.rememberTranscript(operation, normalized);
	await pasteOrSubmitFinalStreamingTranscript(ctx, pi, state, normalized);
}

function keepCompletedStreamingClipAudio(owner: MicmeSessionOwner, operation: MicmeOperation, active: Recording) {
	if (!envFlag("MICME_KEEP_AUDIO")) return false;
	owner.rememberAudioDirectory(operation, active.tempDir);
	return true;
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

async function cleanupOwnedDirectories(operation: MicmeOperation) {
	await Promise.all([...operation.tempDirs].map((tempDir) => cleanup(tempDir).catch(() => undefined)));
}

function createGuardedContext(owner: MicmeSessionOwner, operation: MicmeOperation, ctx: ExtensionContext) {
	const guardedUi = new Proxy(ctx.ui, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			if (!GUARDED_UI_METHODS.has(String(property))) return value.bind(target);
			return (...args: unknown[]) => {
				if (!owner.isCurrent(operation)) return undefined;
				return Reflect.apply(value, target, args);
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
