import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { MIN_AUDIO_BYTES, RECORDER_STARTUP_GRACE_MS, STATUS_KEY } from "./constants.ts";
import {
	envFlag,
	getShortcut,
	getLegacyStreamSettings,
	getTerminalShortcut,
	getTranscriptionMode,
	reloadMicmeConfig,
	requireValidMicmeConfig,
} from "./config.ts";
import { buildRecorderCommand, listAudioDevices, prepareAudioForTranscription, registerDeviceMessageRenderer, validateRecordedAudio } from "./audio.ts";
import { installMicmeEditorFallback, type MicmeEditorInputHandlers } from "./editor.ts";
import { pcm16BufferLevel } from "./audio-level.ts";
import { buildLiveRecorderCommand, openLivePcm, type LivePcmReader } from "./live-capture.ts";
import { ensureLiveModels, resolveLivePlan } from "./live-plan.ts";
import {
	assertExpectedProcessExit,
	formatExit,
	formatProcessOutput,
	hasRecorderExited,
	normalizeTranscript,
	raceWithTimeout,
	spawnLiveWorker,
	spawnRecording,
	stopProcess,
	stopRecorder,
} from "./processes.ts";
import { RecordingWidget } from "./recording-widget.ts";
import { createLiveRecordingDirectory, createRecordingDirectory, type RecordingDirectory } from "./recording-dir.ts";
import { showConfiguration } from "./settings.ts";
import { buildLiveWorkerCommand, caughtUpForLivePreview, livePoll, LiveTranscript, LiveWorker, liveWorkerDiagnostics } from "./streaming.ts";
import { pasteOrSubmitTranscript } from "./transcript-delivery.ts";
import { sanitizeTerminalOutput } from "./terminal-text.ts";
import { transcribe } from "./transcription.ts";
import type { ExitResult, OwnedProcess, Recording } from "./types.ts";

const MICME_ACTIONS = ["devices", "conf", "last", "audio", "help"] as const;
const SHORTCUT_REPEAT_GUARD_MS = 1_000;
const GUARDED_UI_METHODS = new Set(["notify", "pasteToEditor", "setEditorText", "setStatus", "setWidget"]);

type LiveSession = {
	worker: LiveWorker;
	child: OwnedProcess;
	finalizeWithClip: boolean;
	transcript: LiveTranscript;
	reader?: LivePcmReader;
	captureStartup?: Promise<Recording>;
	pump?: Promise<void>;
	startedAt: number;
	firstDraftAt?: number;
	peakLag: number;
	level: number;
	lastPcmAt: number;
	stopping: boolean;
};
type KeptAudio = { note: string; path: string; directory: RecordingDirectory };
type AudioOutcome = "delivered" | "failed" | "shutdown";
export type MicmeOperationPhase = "idle" | "starting" | "recording" | "streaming" | "stopping" | "transcribing" | "finalizing" | "shutting_down";

type MicmeOperation = {
	id: number;
	phase: Exclude<MicmeOperationPhase, "idle">;
	context: ExtensionContext;
	controller: AbortController;
	processes: Set<OwnedProcess>;
	directories: Set<RecordingDirectory>;
	primary?: Recording;
	live?: LiveSession;
	keepAudio?: boolean;
	completion?: Promise<void>;
	startupFailureCleanup?: Promise<unknown>;
};

class EarlyRecorderExitError extends Error {
	private readonly readStderr: Recording["stderr"];

	constructor(exit: ExitResult, recording: Recording, live = false) {
		const help = live ? " Check the audio device or configure the recorder to keep writing a growing 16 kHz mono signed 16-bit PCM WAV until stopped." : "";
		super(`Micme recorder exited early (${formatExit(exit)}).${help}`);
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

	pi.on("session_start", (_event, ctx) => owner.startSession(ctx));
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
	private advisedLiveMigration = false;
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
		if (active.phase === "recording" || active.phase === "streaming" || (active.phase === "starting" && active.live?.reader)) {
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
			notifyExtensionError(guardedContext, error);
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
		const completion = active.completion?.catch(() => undefined) ?? active.live?.pump;
		active.phase = "shutting_down";
		clearLiveDraft(active);
		active.controller.abort();
		active.live?.reader?.close();
		await stopOwnedProcesses(active);
		if (phaseAtShutdown !== "starting" && completion) await raceWithTimeout(completion, 2_000);
		await stopOwnedProcesses(active);
		if (active.startupFailureCleanup) await active.startupFailureCleanup;
		await settleRecordedAudio(this, active, "shutdown");
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
			void this.stop(operation, phase === "streaming" ? new EarlyRecorderExitError(primary.getExit(), primary, true) : undefined);
			return;
		}
		void primary.exitObserved.then((exit) => {
			if (this.isCurrent(operation) && operation.phase === phase) {
				void this.stop(operation, phase === "streaming" ? new EarlyRecorderExitError(exit, primary, true) : undefined);
			}
		});
		const ctx = operation.context;
		ctx.ui.setStatus(STATUS_KEY, `● ${phase} (${sanitizeTerminalOutput(stopHint) || "shortcut"} or /micme)`);
		this.recordingWidget.start(ctx, primary);
	}

	failLiveRecording(operation: MicmeOperation, error: unknown) {
		if (this.isCurrent(operation) && operation.phase === "streaming") void this.stop(operation, error);
	}

	adviseLiveMigration(ctx: ExtensionContext) {
		if (this.advisedLiveMigration) return;
		const keys = getLegacyStreamSettings();
		if (!keys.length) return;
		this.advisedLiveMigration = true;
		ctx.ui.notify(`Micme stream now uses micme-live and the Audio input. Ignored legacy settings: ${keys.join(", ")}. Your saved values were not changed.`, "info");
	}

	async allocateRecordingDirectory(operation: MicmeOperation, tempPrefix: string, live = false) {
		const keepAudio = envFlag("MICME_KEEP_AUDIO");
		const createDirectory = live ? createLiveRecordingDirectory : createRecordingDirectory;
		const directory = await createDirectory(operation.context.cwd, keepAudio, tempPrefix);
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

	pasteLastTranscript(ctx: ExtensionContext) {
		if (!this.closed) pasteOrSubmitTranscript(ctx, this.pi, this.lastTranscript);
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
			if (!this.isCurrent(operation) || operation.completion !== work) return;
			operation.startupFailureCleanup = this.cleanupFailedRecordingStart(operation, error);
			const reportedError = await operation.startupFailureCleanup;
			if (!this.isCurrent(operation)) return;
			notifyExtensionError(operation.context, reportedError);
			this.finish(operation);
			closeOwnedDirectories(operation);
		} finally {
			if (operation.completion === work) operation.completion = undefined;
		}
	}

	private async cleanupFailedRecordingStart(operation: MicmeOperation, error: unknown) {
		this.recordingWidget.clear(operation.context);
		clearLiveDraft(operation);
		operation.live?.reader?.close();
		await stopOwnedProcesses(operation);
		await operation.live?.pump;
		return withKeptAudio(recordingError(operation, error), await settleRecordedAudio(this, operation, "failed"));
	}

	private async stop(operation: MicmeOperation, failure?: unknown) {
		if (!this.transition(operation, "stopping")) return;
		operation.context.ui.setStatus(STATUS_KEY, "stopping…");
		clearLiveDraft(operation);
		this.recordingWidget.clear(operation.context);
		const work = stopAndTranscribe(this, operation, this.pi, failure);
		operation.completion = work;
		try {
			await work;
		} catch (error) {
			if (this.isCurrent(operation)) notifyExtensionError(operation.context, error);
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
		// Clear status before releasing ownership, while the guarded UI still accepts writes.
		operation.context.ui.setStatus(STATUS_KEY, undefined);
		this.current = undefined;
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
				owner.pasteLastTranscript(ctx);
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
		notifyExtensionError(ctx, error);
	}
}

async function handleMicmeTerminalShortcut(owner: MicmeSessionOwner, ctx: ExtensionContext) {
	try {
		await owner.handleTerminalShortcut(ctx);
	} catch (error) {
		notifyExtensionError(ctx, error);
	}
}

function createMicmeEditorHandlers(owner: MicmeSessionOwner, ctx: ExtensionContext): MicmeEditorInputHandlers {
	return {
		toggle: () => owner.toggle(ctx).catch((error) => notifyExtensionError(ctx, error)),
	};
}

function notifyExtensionError(ctx: ExtensionContext, error: unknown) {
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
	operation.primary = active;
	operation.processes.add(active);
	const earlyExit = await raceWithTimeout(active.exitObserved, RECORDER_STARTUP_GRACE_MS);
	if (!owner.isCurrent(operation)) return;
	if (earlyExit) throw new EarlyRecorderExitError(earlyExit, active);

	owner.activateRecording(operation, "recording", active, stopHint);
}

async function startStreamingTranscription(owner: MicmeSessionOwner, operation: MicmeOperation, ctx: ExtensionContext, stopHint: string) {
	owner.adviseLiveMigration(ctx);
	const plan = resolveLivePlan();
	const { signal } = operation.controller;
	ctx.ui.setStatus(STATUS_KEY, "preparing live models…");
	await ensureLiveModels(plan, ctx, signal);
	signal.throwIfAborted();

	ctx.ui.setStatus(STATUS_KEY, "loading live models…");
	const child = spawnLiveWorker(buildLiveWorkerCommand(plan));
	operation.processes.add(child);
	const worker = new LiveWorker(child, signal, (update) => {
		if (!owner.isCurrent(operation) || worker.signal.aborted) return;
		const { primary, live } = operation;
		if (!primary || !live) return;
		if (update.type === "final") {
			primary.liveDraft = undefined;
			live.transcript.commit(update.text);
		} else if (!live.stopping) {
			primary.liveDraft = update.text || undefined;
			if (update.text) live.firstDraftAt ??= performance.now();
		}
	});
	const live: LiveSession = {
		worker, child, finalizeWithClip: plan.finalizeWithClip, transcript: new LiveTranscript(ctx),
		startedAt: 0, peakLag: 0, level: 0, lastPcmAt: 0, stopping: false,
	};
	operation.live = live;
	const ready = await worker.ready;
	worker.signal.throwIfAborted();
	if (envFlag("MICME_STREAM_DIAGNOSTICS")) {
		ctx.ui.notify(`Micme live model load: ${Math.round(ready.loadMs)} ms (ASR ${ready.asrLoads}, VAD ${ready.vadLoads})`, "info");
	}

	ctx.ui.setStatus(STATUS_KEY, "waiting for live audio…");
	live.captureStartup = startLiveCapture(owner, operation, live);
	const active = await live.captureStartup;
	worker.signal.throwIfAborted();
	if (operation.phase !== "starting") return;
	live.startedAt = performance.now();
	worker.signal.addEventListener("abort", () => owner.failLiveRecording(operation, worker.failure), { once: true });
	owner.activateRecording(operation, "streaming", active, stopHint);
}

async function startLiveCapture(owner: MicmeSessionOwner, operation: MicmeOperation, live: LiveSession) {
	const { worker } = live;
	const { signal } = worker;
	const directory = await owner.allocateRecordingDirectory(operation, "micme-stream-", true);
	if (!owner.isCurrent(operation)) await cleanupRecordingDirectory(owner, operation, directory);
	signal.throwIfAborted();
	const audioPath = join(directory.filesPath, "raw.wav");
	const command = await buildLiveRecorderCommand(audioPath, directory, signal);
	signal.throwIfAborted();
	const active = spawnRecording(command, audioPath, directory.path, directory);
	active.audioLevel = () => performance.now() - live.lastPcmAt < 250 ? live.level : 0;
	active.livePcmMeter = true;
	operation.primary = active;
	operation.processes.add(active);
	void active.exitObserved.then((exit) => {
		if (operation.phase === "starting") worker.fail(new EarlyRecorderExitError(exit, active, true));
	});
	const timer = setTimeout(() => {
		worker.fail(new Error("Micme timed out waiting for live PCM. Check the microphone or configure a growing 16 kHz mono signed 16-bit PCM WAV recorder."));
	}, worker.timeoutMs);
	try {
		const reader = await openLivePcm(audioPath, directory, signal);
		live.reader = reader;
		operation.context.ui.setStatus(STATUS_KEY, "waiting for microphone samples…");
		const first = await firstLivePcm(live, reader);
		signal.throwIfAborted();
		if (first) live.pump = pumpLivePcm(live, reader, first).catch((error: unknown) => worker.fail(error));
		return active;
	} catch (error) {
		live.reader?.close();
		throw worker.failure ?? error;
	} finally {
		clearTimeout(timer);
	}
}

async function firstLivePcm(live: LiveSession, reader: LivePcmReader) {
	while (!live.stopping) {
		const block = await reader.read(false);
		if (block.pcm.length) return block;
		if (!live.stopping) await livePoll(live.worker.signal);
	}
	// The user may stop after the verified file opened but before it has any
	// samples. Let the recorder close its header, then validate it in final drain.
	return undefined;
}

async function pumpLivePcm(live: LiveSession, reader: LivePcmReader, first: Awaited<ReturnType<LivePcmReader["read"]>>) {
	const { worker } = live;
	let block = first;
	for (;;) {
		worker.signal.throwIfAborted();
		if (block.pcm.length) {
			// A block read concurrently with stop must still be fed before the final drain.
			const preview = !live.stopping && caughtUpForLivePreview(block.availableThrough, worker.through);
			await sendLivePcm(live, block, preview);
		}
		if (live.stopping) return;
		if (!block.pcm.length) {
			await livePoll(worker.signal);
			if (live.stopping) return;
		}
		block = await reader.read(false);
	}
}

function sendLivePcm(live: LiveSession, block: Awaited<ReturnType<LivePcmReader["read"]>>, preview: boolean) {
	live.level = pcm16BufferLevel(block.pcm);
	live.lastPcmAt = performance.now();
	live.peakLag = Math.max(live.peakLag, block.availableThrough - live.worker.through);
	return live.worker.send(block.pcm, preview);
}

async function stopAndTranscribe(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI, failure: unknown) {
	const active = operation.primary;
	if (!active) throw new Error("Micme lost ownership of its recording process.");
	if (operation.live) await stopStreamingTranscription(owner, operation, pi, active, operation.live, failure);
	else await stopClipAndTranscribe(owner, operation, pi, active);
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
		throw withKeptAudio(error, await settleRecordedAudio(owner, operation, "failed"));
	}

	await deliverTranscribedClip(owner, operation, pi, transcript);
}

async function stopStreamingTranscription(
	owner: MicmeSessionOwner,
	operation: MicmeOperation,
	pi: ExtensionAPI,
	active: Recording,
	live: LiveSession,
	failure: unknown,
) {
	const ctx = operation.context;
	const { worker, reader } = live;
	live.stopping = true;
	let transcript: string;
	let refined = false;
	try {
		if (failure !== undefined) throw failure;
		if (!reader) throw new Error("Micme lost its verified PCM reader.");
		const exit = await stopProcess(active);
		worker.signal.throwIfAborted();
		assertExpectedProcessExit(active, exit, "recorder");
		owner.transition(operation, "finalizing");
		ctx.ui.setStatus(STATUS_KEY, "finalizing stream…");
		const done = await finishLiveWorker(live, reader);
		await stopProcess(live.child); // Release the supervisor and any inherited workers.
		worker.signal.throwIfAborted();
		if (envFlag("MICME_STREAM_DIAGNOSTICS")) {
			const firstDraft = live.firstDraftAt === undefined ? "none" : `${Math.round(live.firstDraftAt - live.startedAt)} ms`;
			ctx.ui.notify(`Micme live: first draft ${firstDraft}; ${done.through} samples, peak lag ${live.peakLag} samples, ${done.vadFrames} VAD frames, ${done.asrCalls} ASR calls in ${Math.round(done.asrMs)} ms`, "info");
		}
		transcript = live.transcript.text;
		if (transcript && live.finalizeWithClip) {
			try {
				transcript = await refineLiveTranscript(operation, reader, done.through);
				refined = true;
			} catch (error) {
				if (!owner.isCurrent(operation)) return;
				owner.rememberTranscript(operation, live.transcript.text);
				reader.close();
				const kept = await settleRecordedAudio(owner, operation, "failed");
				const message = sanitizeTerminalOutput(withKeptAudio(error, kept).message);
				ctx.ui.notify(`Micme saved the confirmed live transcript for /micme last because final clip refinement failed: ${message}`, "warning");
				return;
			}
		}
	} catch (error) {
		worker.fail(error);
		await stopOwnedProcesses(operation);
		await live.pump;
		reader?.close();
		if (!owner.isCurrent(operation)) return;
		throw withKeptAudio(recordingError(operation, error), await settleRecordedAudio(owner, operation, "failed"));
	} finally {
		reader?.close();
	}

	if (!owner.isCurrent(operation)) return;
	try {
		if (!transcript) ctx.ui.notify("Micme did not recognize any words in the live stream.", "warning");
		else {
			owner.rememberTranscript(operation, transcript);
			live.transcript.deliver(pi, transcript, refined);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Micme could not deliver the transcript: ${message}`, { cause: error });
	} finally {
		if (owner.isCurrent(operation)) await settleRecordedAudio(owner, operation, "delivered");
	}
}

async function finishLiveWorker(live: LiveSession, reader: LivePcmReader) {
	const { worker } = live;
	const timer = setTimeout(() => worker.fail(new Error("Micme timed out draining the final live PCM.")), worker.timeoutMs);
	try {
		await live.captureStartup;
		await live.pump;
		for (;;) {
			worker.signal.throwIfAborted();
			const block = await reader.read(true);
			if (!block.pcm.length) {
				if (block.availableThrough !== worker.through) throw new Error("Micme did not acknowledge all captured PCM samples.");
				return await worker.finish();
			}
			await sendLivePcm(live, block, false);
		}
	} finally {
		clearTimeout(timer);
	}
}

async function refineLiveTranscript(operation: MicmeOperation, reader: LivePcmReader, through: number) {
	requireValidMicmeConfig();
	const { context: ctx, controller: { signal } } = operation;
	const target = await createLiveRecordingDirectory(ctx.cwd, false, "micme-refine-");
	try {
		const audioPath = await reader.writeRefinementInput(target, through, signal);
		await validateAudioForTranscription(ctx, audioPath, signal, target.cwdFd);
		signal.throwIfAborted();
		const text = normalizeTranscript(await transcribe(audioPath, target.filesPath, ctx, signal, target));
		if (!text) throw new Error("Micme did not receive any final transcript text.");
		return text;
	} finally {
		try {
			await target.remove();
		} finally {
			target.close();
		}
	}
}

// The one place that decides what happens to recorded audio when an operation ends:
// - failed: keep captured audio so the failure can be debugged; the caller says where.
// - delivered or shutdown: keep captured audio only when Keep audio is on.
// Captured means at least MIN_AUDIO_BYTES, so a header-only WAV is not kept.
async function settleRecordedAudio(owner: MicmeSessionOwner, operation: MicmeOperation, outcome: AudioOutcome) {
	const kept = outcome === "failed" || operation.keepAudio ? findCapturedAudio(operation) : undefined;
	if (kept) owner.rememberAudioDirectory(operation, kept.path);
	const removable = [...operation.directories].filter((directory) => directory !== kept?.directory);
	await Promise.all(removable.map((directory) => cleanupRecordingDirectory(owner, operation, directory)));
	return kept;
}

function findCapturedAudio(operation: MicmeOperation): KeptAudio | undefined {
	const clip = operation.primary;
	if (!clip?.directory) return;
	const { directory } = clip;
	try {
		if (!directory.hasRegularFile(clip.audioPath, MIN_AUDIO_BYTES)) return;
	} catch {
		// Failed inspection is not proof that the directory is safe to delete.
		return { note: "Audio may remain in", path: directory.path, directory };
	}
	return { note: "Audio kept for debugging", path: directory.path, directory };
}

function withKeptAudio(error: unknown, kept: KeptAudio | undefined) {
	const message = error instanceof Error ? error.message : String(error);
	if (!kept) return error instanceof Error ? error : new Error(message);
	return new Error(`${message}\n${kept.note}: ${sanitizeTerminalOutput(kept.path)}`, { cause: error });
}

function recordingError(operation: MicmeOperation, error: unknown) {
	// Hook exit observation can precede the bounded stderr drain.
	if (error instanceof EarlyRecorderExitError) return error.withDiagnostics();
	const stderr = operation.live && liveWorkerDiagnostics(operation.live.child);
	if (!stderr) return error;
	return new Error(`${error instanceof Error ? error.message : String(error)}\nLive worker output:\n${stderr}`);
}

async function validateAudioForTranscription(ctx: ExtensionContext, audioPath: string, signal: AbortSignal, cwdFd?: number) {
	const outcome = await validateRecordedAudio(audioPath, signal, cwdFd);
	if (outcome.status !== "skipped" || outcome.reason !== "ffmpeg-unavailable") return;
	ctx.ui.notify("Micme skipped silence validation because ffmpeg was not found. Install ffmpeg or set MICME_VALIDATE_AUDIO=0 to disable the silence guard.", "warning");
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

async function deliverTranscribedClip(owner: MicmeSessionOwner, operation: MicmeOperation, pi: ExtensionAPI, transcript: string) {
	const ctx = operation.context;
	owner.rememberTranscript(operation, transcript);
	try {
		pasteOrSubmitTranscript(ctx, pi, transcript);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Micme could not deliver the transcript: ${message}`, { cause: error });
	} finally {
		if (owner.isCurrent(operation)) await settleRecordedAudio(owner, operation, "delivered");
	}
}

function clearLiveDraft(operation: MicmeOperation) {
	if (operation.primary) operation.primary.liveDraft = undefined;
}

async function stopOwnedProcesses(operation: MicmeOperation) {
	await Promise.all([...operation.processes].map((active) => stopProcess(active).catch(() => undefined)));
}

function closeOwnedDirectories(operation: MicmeOperation) {
	for (const directory of operation.directories) directory.close();
	operation.directories.clear();
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
	const guardedUi = new Proxy(ctx.ui, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			if (!GUARDED_UI_METHODS.has(String(property))) return value.bind(target);
			return (...args: unknown[]) => isCurrent() ? Reflect.apply(value, target, args) as unknown : undefined;
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
