import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { MIN_AUDIO_BYTES, RECORDER_STARTUP_GRACE_MS, RECORDING_WIDGET_KEY, STATUS_KEY } from "./constants.ts";
import {
	env,
	envFlag,
	expandConfigPath,
	getShortcut,
	getLegacyStreamSettings,
	getPrintableShortcuts,
	getTerminalShortcut,
	getTranscriptionMode,
	getTransferOptions,
	getTranslateToEnglishLanguage,
	reloadMicmeConfig,
	requireValidMicmeConfig,
} from "./config.ts";
import { buildOwnedClipRecorderCommand, listAudioDevices, prepareAudioForTranscription, prepareRestoredDevicePanels, registerDeviceMessageRenderer, validateRecordedAudio } from "./audio.ts";
import type { MicmeEditorInputHandlers } from "./editor.ts";
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
import type { RecordingWidget } from "./recording-widget.ts";
import { createClipRecordingDirectory, createLiveRecordingDirectory, type RecordingDirectory } from "./recording-dir.ts";
import { buildLiveWorkerCommand, caughtUpForLivePreview, livePoll, LiveTranscript, LiveWorker, liveWorkerDiagnostics } from "./streaming.ts";
import { pasteOrSubmitTranscript } from "./transcript-delivery.ts";
import { sanitizeTerminalOutput } from "./terminal-text.ts";
import { resolveTranscriptionPlan } from "./backends.ts";
import { getWhisperCppModelNameFromPath, isEnglishOnlyWhisperModelName, isTranslationUnsupportedWhisperModelName } from "./models.ts";
import { transcribe } from "./transcription.ts";
import { freezeAudio, initialCapture, noteLiveBlock, observeCapture } from "./transfer/capture.ts";
import { MICME_TRANSFER_ACTIONS, type Capture, type Choice, type EntryId, type Final, type Host, type ReviewTrial, type Row, type Selection, type SetForeground, type TransferAction, type VerifiedAudio } from "./transfer/contracts.ts";
import {
	ArtifactDecoder, installedTrialModel, markDeliveryFailed, preparePolish, requireTrialSample, saveDictation, selectedChoice, showProcessingWarnings,
	showRuleOutcomes, showTakeReview, showTransferAction, transcribeTrial,
} from "./transfer/host.ts";
import type { ExitResult, OwnedProcess, Recording } from "./types.ts";

const MICME_ACTIONS = ["devices", "conf", "last", "audio", "help", ...MICME_TRANSFER_ACTIONS] as const;
const SHORTCUT_REPEAT_GUARD_MS = 1_000;
const GUARDED_UI_METHODS = new Set(["notify", "pasteToEditor", "setEditorText", "setStatus", "setWidget", "setEditorComponent", "custom", "confirm", "select", "input", "editor"]);
const EDITOR_WRITE_METHODS = new Set(["pasteToEditor", "setEditorText", "setEditorComponent"]);
let foregroundTakes = 0;

type PcmDecoder = Pick<LiveWorker, "through" | "timeoutMs" | "signal" | "failure" | "fail" | "send">;
type LiveSession = {
	decoder: PcmDecoder;
	legacy?: { worker: LiveWorker; child: OwnedProcess; finalizeWithClip: boolean };
	transcript: LiveTranscript;
	captureStartup?: Promise<Recording>;
	pump?: Promise<void>;
	startedAt: number;
	firstDraftAt?: number;
	peakLag: number;
	level: number;
	lastPcmAt: number;
	stopping: boolean;
};
type KeptAudio = { note: string; path?: string; directory: RecordingDirectory };
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
	reader?: LivePcmReader;
	live?: LiveSession;
	capture: Capture;
	clipObservation?: Promise<void>;
	stopHint: string;
	keepAudio?: boolean;
	history: boolean;
	modelId: string | null;
	language?: string | null;
	selection?: Selection;
	trial?: { input: ReviewTrial; installed: ReturnType<typeof installedTrialModel> };
	engine?: { choice: Choice; decoder: ArtifactDecoder; abort?: Promise<void> };
	verified?: VerifiedAudio | null;
	foreground?: () => void;
	detachTrial?: () => void;
	completion?: Promise<void>;
	startupFailureCleanup?: Promise<unknown>;
	teardown?: Promise<void>;
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
	const terminalShortcut = getTerminalShortcut();
	const previewShortcut = terminalShortcut?.toLowerCase() === "alt+3" ? "alt+7" : "alt+3";

	pi.registerCommand("micme", {
		description: "Toggle local voice recording and paste the transcript into the editor",
		getArgumentCompletions: getMicmeArgumentCompletions,
		handler: async (args, ctx) => handleMicmeCommand(owner, pi, args, ctx, previewShortcut),
	});

	if (terminalShortcut) {
		pi.registerShortcut(terminalShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Micme: toggle local voice recording",
			handler: async (ctx) => handleMicmeTerminalShortcut(owner, ctx),
		});
	}
	pi.registerShortcut(previewShortcut, {
		description: "Micme: preview the saved live final without submitting the composer",
		handler: (ctx) => owner.runTransferAction(ctx, "preview"),
	});

	pi.on("session_start", (_event, ctx) => owner.startSession(ctx));
	pi.on("session_shutdown", async (_event, ctx) => owner.shutdown(ctx));
	return owner;
}

export class MicmeSessionOwner {
	private recordingWidget: RecordingWidget | undefined;
	private captureLabel?: typeof import("./recording-widget.ts").captureLabel;
	private readonly sessionController = new AbortController();
	private readonly sessionWork = new Set<Promise<void>>();
	private current: MicmeOperation | undefined;
	private closed = false;
	private nextOperationId = 1;
	private lastShortcutInputAt = 0;
	private lastTranscript = "";
	private lastLiveFinal: ReturnType<Host["lastLive"]> = null;
	private actionController?: AbortController;
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

	async startSession(ctx: ExtensionContext) {
		const config = reloadMicmeConfig();
		if (this.closed) return;
		if (!config.error && getTransferOptions().MICME_HISTORY) await this.runSessionWork(ctx, enforceHistoryRetention);
		if (ctx.mode !== "tui" || this.closed) return;
		await prepareRestoredDevicePanels(ctx);
		if (!getPrintableShortcuts().length || this.closed) return;
		const { installMicmeEditorFallback } = await import("./editor.ts");
		if (!this.closed) installMicmeEditorFallback(ctx, createMicmeEditorHandlers(this, ctx));
	}

	async toggle(ctx: ExtensionContext) {
		if (this.closed) return;
		const active = this.current;
		if (!active) {
			if (!this.actionController) await this.start(ctx);
			else ctx.ui.notify("Close the current Micme view before recording.", "warning");
			return;
		}
		if (active.phase === "recording" || active.phase === "streaming" || (active.phase === "starting" && active.reader && active.live)) {
			await this.stop(active);
			return;
		}
		ctx.ui.notify(`Micme is ${formatOperationPhase(active.phase)}. Wait for it to finish before toggling again.`, "warning");
	}

	async handleTerminalShortcut(ctx: ExtensionContext) {
		if (this.isShortcutAutoRepeat()) return;
		await this.toggle(ctx);
	}

	async runTransferAction(ctx: ExtensionContext, action: Exclude<TransferAction, "cancel">) {
		if (this.closed) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`/micme ${action} requires interactive TUI mode.`, "warning");
			return;
		}
		if (this.current || this.actionController) {
			ctx.ui.notify("Micme is busy. Finish or cancel the current take or view first.", "warning");
			return;
		}
		const actionController = new AbortController();
		this.actionController = actionController;
		const signal = AbortSignal.any([this.sessionController.signal, actionController.signal]);
		const activeView = () => !signal.aborted && this.actionController === actionController;
		const host: Host = {
			startReviewTrial: async (input, trialSignal) => {
				if (activeView()) await this.startReviewTrial(ctx, input, AbortSignal.any([signal, trialSignal]));
			},
			startProcessedClip: async (selection) => {
				if (!activeView()) return;
				this.assertAvailable(ctx);
				await this.start(ctx, { selection: { ...selection, endpoint: selection.endpoint ? new URL(selection.endpoint) : null } }, signal);
			},
			cancel: async () => { if (activeView()) await this.cancel(ctx); },
			lastLive: () => !activeView() || !this.lastLiveFinal ? null : structuredClone(this.lastLiveFinal),
		};
		const guarded = createGuardedContext(ctx, activeView, true);
		try {
			await this.runSessionWork(guarded, (view) => showTransferAction(view, host, action, signal), signal);
		} finally {
			if (this.actionController === actionController) this.actionController = undefined;
		}
	}

	async startReviewTrial(ctx: ExtensionContext, input: ReviewTrial, signal: AbortSignal) {
		signal.throwIfAborted();
		this.assertAvailable(ctx);
		requireValidMicmeConfig();
		await this.start(ctx, { trial: { input, installed: installedTrialModel() } }, signal);
	}

	async cancel(ctx: ExtensionContext) {
		this.actionController?.abort();
		if (this.current) await this.cancelOperation(this.current, ctx);
	}

	async runSessionWork(ctx: ExtensionContext, work: (ctx: ExtensionContext, signal: AbortSignal) => Promise<void>, signal = this.sessionController.signal) {
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
		this.sessionController.abort();
		const pendingSessionWork = Promise.allSettled(this.sessionWork);
		if (this.current) await this.cancelOperation(this.current, ctx);
		else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			this.clearRecordingWidget(ctx);
		}
		await pendingSessionWork;
	}

	private cancelOperation(active: MicmeOperation, ctx: ExtensionContext) {
		active.teardown ??= this.disposeOperation(active, ctx);
		return active.teardown;
	}

	private async disposeOperation(active: MicmeOperation, ctx: ExtensionContext) {
		const phaseAtShutdown = active.phase;
		const completion = active.completion?.catch(() => undefined) ?? active.live?.pump;
		active.phase = "shutting_down";
		active.detachTrial?.();
		active.controller.abort();
		clearLiveDraft(active);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		this.clearRecordingWidget(ctx);
		try {
			await stopOwnedProcesses(active);
			const finished = !completion || await raceWithTimeout(completion.then(() => true), phaseAtShutdown === "starting" ? 0 : 2_000);
			await stopOwnedProcesses(active);
			if (active.startupFailureCleanup) await active.startupFailureCleanup;
			// A late consumer may still own a borrowed fd. Release it only once
			// the startup/finalization and the sole capture read have finished.
			const release = async () => {
				await active.clipObservation;
				await settleRecordedAudio(this, active, "shutdown");
				closeRecordingResources(active);
			};
			if (!finished && completion && this.closed) void completion.then(release);
			else {
				await completion;
				await release();
			}
		} finally {
			releaseForeground(active);
			if (this.current === active) this.current = undefined;
		}
	}

	isCurrent(operation: MicmeOperation) {
		return !this.closed && this.current === operation && !operation.controller.signal.aborted;
	}

	transition(operation: MicmeOperation, phase: MicmeOperation["phase"]) {
		if (!this.isCurrent(operation)) return false;
		operation.phase = phase;
		return true;
	}

	activateRecording(operation: MicmeOperation, phase: "recording" | "streaming", primary: Recording) {
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
		if (phase === "recording") this.showRecordingWidget(operation, primary);
	}

	showRecordingWidget(operation: MicmeOperation, primary: Recording) {
		if (!this.isCurrent(operation)) return;
		this.recordingWidget?.start(operation.context, primary, () => operation.capture);
	}

	publishCapture(operation: MicmeOperation, state: Capture) {
		if (!this.isCurrent(operation) || operation.capture === state) return;
		const prior = operation.capture;
		operation.capture = state;
		if (prior.stage === state.stage && prior.firstSampleMs === state.firstSampleMs) return;
		const label = this.captureLabel?.(state.stage) ?? state.stage;
		if (state.stage === "waiting" && operation.live) {
			operation.context.ui.setStatus(STATUS_KEY, "waiting for microphone samples…");
		} else if (state.stage === "waiting" || state.stage === "opaque-running" || state.stage === "samples" || state.stage === "digital-zero") {
			const clip = !operation.live;
			const ready = state.firstSampleMs !== null;
			const prefix = clip ? (ready ? "● recording " : "○ recording ") : (ready ? "● streaming " : "");
			operation.context.ui.setStatus(STATUS_KEY, `${prefix}(${label}; ${operation.stopHint} or /micme to stop; /micme cancel to discard)`);
		} else {
			operation.context.ui.setStatus(STATUS_KEY, label);
		}
		this.recordingWidget?.refresh();
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
		const keepAudio = !operation.trial && envFlag("MICME_KEEP_AUDIO");
		const createDirectory = live ? createLiveRecordingDirectory : createClipRecordingDirectory;
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

	rememberLive(operation: MicmeOperation, final: Final, row: EntryId | null) {
		if (this.isCurrent(operation)) this.lastLiveFinal = { final, row };
	}

	pasteLastTranscript(ctx: ExtensionContext) {
		if (!this.closed && !this.current?.controller.signal.aborted) pasteOrSubmitTranscript(ctx, this.pi, this.lastTranscript);
	}

	deliverClip(operation: MicmeOperation, transcript: string) {
		if (this.isCurrent(operation)) pasteOrSubmitTranscript(operation.context, this.pi, transcript);
	}

	deliverLive(operation: MicmeOperation, transcript: string, replace: boolean) {
		if (this.isCurrent(operation)) operation.live?.transcript.deliver(this.pi, transcript, replace);
	}

	notifyLastAudioDirectory(ctx: ExtensionContext) {
		ctx.ui.notify(this.lastAudioDir ? `Last Micme audio directory: ${sanitizeTerminalOutput(this.lastAudioDir)}` : "No kept Micme audio yet. Set MICME_KEEP_AUDIO=1.", "info");
	}

	private assertAvailable(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || this.closed || this.current) throw new Error("Micme needs an idle, interactive Pi session for this action.");
	}

	private async start(ctx: ExtensionContext, target?: Pick<MicmeOperation, "trial" | "selection">, signal?: AbortSignal) {
		requireValidMicmeConfig();
		signal?.throwIfAborted();
		const operation = this.beginOperation(ctx, target);
		if (signal) {
			const abort = () => { void this.cancelOperation(operation, ctx); };
			signal.addEventListener("abort", abort, { once: true });
			operation.detachTrial = () => signal.removeEventListener("abort", abort);
		}
		const work = this.startWithRecordingWidget(operation);
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
			closeRecordingResources(operation);
		} finally {
			if (operation.completion === work) operation.completion = undefined;
		}
	}

	private async startWithRecordingWidget(operation: MicmeOperation) {
		const { setForeground } = await import("./transfer/jobs.ts");
		if (!this.isCurrent(operation)) return;
		operation.foreground = holdForeground(setForeground);
		if (operation.trial?.input.kind === "sample") {
			try {
				await runSampleTrial(this, operation, operation.trial.input.file);
			} finally {
				if (this.isCurrent(operation)) {
					await settleRecordedAudio(this, operation, "delivered");
					closeRecordingResources(operation);
				}
			}
			this.finish(operation);
			return;
		}
		if (!this.recordingWidget) {
			const { RecordingWidget, captureLabel } = await import("./recording-widget.ts");
			if (!this.isCurrent(operation)) return;
			this.captureLabel = captureLabel;
			this.recordingWidget = new RecordingWidget();
		}
		await startRecording(this, operation);
	}

	private clearRecordingWidget(ctx: ExtensionContext) {
		if (this.recordingWidget) this.recordingWidget.clear(ctx);
		else ctx.ui.setWidget(RECORDING_WIDGET_KEY, undefined);
	}

	private async cleanupFailedRecordingStart(operation: MicmeOperation, error: unknown) {
		this.clearRecordingWidget(operation.context);
		clearLiveDraft(operation);
		const deviceFailure = error instanceof EarlyRecorderExitError || (operation.primary !== undefined && operation.capture.firstSampleMs === null);
		this.publishCapture(operation, { ...operation.capture, stage: deviceFailure ? "device-failed" : "asr-failed" });
		await stopOwnedProcesses(operation);
		await operation.live?.pump;
		await operation.clipObservation;
		const audio = operation.reader || operation.history ? await verifiedRecording(this, operation) : null;
		if (operation.primary) await saveOperationTake(operation, null, "asr-failed", audio);
		return withKeptAudio(recordingError(operation, error), await settleRecordedAudio(this, operation, operation.trial ? "delivered" : "failed"));
	}

	private async stop(operation: MicmeOperation, failure?: unknown) {
		if (!this.transition(operation, "stopping")) return;
		operation.context.ui.setStatus(STATUS_KEY, "stopping…");
		clearLiveDraft(operation);
		this.clearRecordingWidget(operation.context);
		const work = stopAndTranscribe(this, operation, failure);
		operation.completion = work;
		try {
			await work;
		} catch (error) {
			if (this.isCurrent(operation)) notifyExtensionError(operation.context, error);
		} finally {
			if (operation.completion === work) operation.completion = undefined;
			if (this.isCurrent(operation)) {
				this.finish(operation);
				closeRecordingResources(operation);
			}
		}
	}

	private beginOperation(ctx: ExtensionContext, target?: Pick<MicmeOperation, "trial" | "selection">) {
		const operation: MicmeOperation = {
			id: this.nextOperationId++,
			phase: "starting",
			context: ctx,
			controller: new AbortController(),
			processes: new Set(),
			directories: new Set(),
			capture: initialCapture("builtin"),
			stopHint: sanitizeTerminalOutput(getShortcut()) || "shortcut",
			history: !target?.trial && getTransferOptions().MICME_HISTORY,
			modelId: null,
			...target,
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
		operation.detachTrial?.();
		releaseForeground(operation);
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

async function handleMicmeCommand(owner: MicmeSessionOwner, pi: ExtensionAPI, args: string, ctx: ExtensionContext, previewShortcut: string) {
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
				await owner.runSessionWork(ctx, openMicmeSettings);
				return;
			case "cancel":
				await owner.cancel(ctx);
				return;
			case "setup":
			case "history":
			case "import":
			case "polish":
			case "preview":
				await owner.runTransferAction(ctx, action);
				return;
			case "last":
				owner.pasteLastTranscript(ctx);
				return;
			case "audio":
				owner.notifyLastAudioDirectory(ctx);
				return;
			case "help":
				ctx.ui.notify(getHelpText(previewShortcut), "info");
				return;
			default:
				ctx.ui.notify(`Unknown micme action: ${sanitizeTerminalOutput(action) || "(empty)"}. Try /micme help`, "warning");
		}
	} catch (error) {
		notifyExtensionError(ctx, error);
	}
}

async function enforceHistoryRetention(_ctx: ExtensionContext, signal: AbortSignal) {
	const { enforceActiveRetention } = await import("./transfer/retention.ts");
	signal.throwIfAborted();
	await enforceActiveRetention(signal);
}

async function openMicmeSettings(ctx: ExtensionContext, signal: AbortSignal) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/micme conf requires interactive TUI mode.", "warning");
		return;
	}
	const { showConfiguration } = await import("./settings.ts");
	await showConfiguration(ctx, signal);
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

function getHelpText(previewShortcut: string) {
	const shortcut = sanitizeTerminalOutput(getShortcut()) || "not set";
	const actions = MICME_ACTIONS.filter((action) => action !== "help").join("|");
	return `Usage: /micme [${actions}]. Shortcut: ${shortcut} starts or stops recording. /micme cancel stops without transcription or delivery.\n` +
		`${previewShortcut} opens live-final preview without submitting your draft. Use /micme preview only from an empty composer.`;
}

async function runSampleTrial(owner: MicmeSessionOwner, operation: MicmeOperation, path: string) {
	const { controller: { signal }, trial } = operation;
	if (!trial) return;
	await requireTrialSample(path);
	signal.throwIfAborted();
	const directory = await owner.allocateRecordingDirectory(operation, "micme-trial-");
	signal.throwIfAborted();
	owner.transition(operation, "transcribing");
	owner.publishCapture(operation, { ...operation.capture, stage: "processing" });
	const text = await transcribeTrial(trial.installed, path, directory, signal);
	await reviewTrial(operation, text);
}

async function reviewTrial(operation: MicmeOperation, text: string) {
	const { context, controller: { signal } } = operation;
	signal.throwIfAborted();
	if (!text) {
		context.ui.notify("Micme Try It did not recognize any words. Check the audio input and selected language.", "warning");
		return;
	}
	await showTakeReview(context, "Try It · Review only", text, signal);
}

async function startRecording(owner: MicmeSessionOwner, operation: MicmeOperation) {
	const { context: ctx, controller: { signal } } = operation;
	const options = getTransferOptions();
	const streaming = !operation.trial && !operation.selection && getTranscriptionMode() === "stream";
	if (!operation.trial && options.MICME_ARTIFACT) {
		ctx.ui.setStatus(STATUS_KEY, "loading selected speech model…");
		await openArtifact(owner, operation, await selectedChoice(options, signal), streaming);
		signal.throwIfAborted();
		if (operation.live) return startLiveSession(owner, operation, operation.live);
	} else if (streaming) {
		return startStreamingTranscription(owner, operation, ctx);
	}
	if (!operation.engine && !operation.trial) {
		const explicit = getTranslateToEnglishLanguage() && env("MICME_WHISPER_CPP_MODEL")?.trim();
		if (explicit || operation.history) {
			const plan = resolveTranscriptionPlan({ transcriptionMode: "clip" });
			if (explicit && plan.effectiveBackend === "whisper.cpp") {
				// Check the selected weight, not the multilingual sibling the legacy resolver may suggest.
				const name = getWhisperCppModelNameFromPath(expandConfigPath(explicit))?.replace(/-q\d+_\d+$/i, "");
				if (isEnglishOnlyWhisperModelName(name) || isTranslationUnsupportedWhisperModelName(name)) {
					throw new Error("The selected Whisper model does not support translation to English. Choose a translation-capable multilingual model in /micme conf or turn off MICME_TRANSLATE_TO_ENGLISH.");
				}
			}
			if (operation.history) operation.modelId = plan.modelName ?? null;
		}
	}
	await startClipRecording(owner, operation);
}

async function startClipRecording(owner: MicmeSessionOwner, operation: MicmeOperation) {
	const { controller: { signal } } = operation;
	const directory = await owner.allocateRecordingDirectory(operation, "micme-", Boolean(operation.engine));
	if (!owner.isCurrent(operation)) {
		await cleanupRecordingDirectory(owner, operation, directory);
		return;
	}

	const audioPath = join(directory.filesPath, "raw.wav");
	const command = operation.engine
		? await buildLiveRecorderCommand(audioPath, directory, signal)
		: await buildOwnedClipRecorderCommand(audioPath, directory, Boolean(operation.keepAudio), signal);
	if (!owner.isCurrent(operation)) return;
	const active = spawnRecording(command, audioPath, directory.path, directory);
	operation.primary = active;
	operation.processes.add(active);
	const source = command.capture?.source ?? "builtin";
	operation.capture = initialCapture(source, command.capture?.requested);
	const earlyExit = await raceWithTimeout(active.exitObserved, RECORDER_STARTUP_GRACE_MS);
	if (!owner.isCurrent(operation)) return;
	if (earlyExit) throw new EarlyRecorderExitError(earlyExit, active);

	owner.activateRecording(operation, "recording", active);
	if (operation.phase === "recording") {
		operation.clipObservation = observeCapture(active, "clip", source, (capture) => {
			if (operation.phase === "recording") owner.publishCapture(operation, capture);
		}, signal);
	}
}

async function openArtifact(owner: MicmeSessionOwner, operation: MicmeOperation, choice: Choice, streaming: boolean) {
	const { openRecognizer } = await import("./transfer/recognition.ts");
	const decoder = new ArtifactDecoder(operation.controller.signal);
	decoder.signal.throwIfAborted();
	operation.modelId = choice.variantId;
	operation.engine = { choice, decoder };
	if (streaming) operation.live = createLiveSession(operation.context, decoder);
	decoder.recognizer = await openRecognizer(choice, (word) => {
		const { primary, live } = operation;
		if (!owner.isCurrent(operation) || !primary || !live || !decoder.recognizer?.traits.stream || decoder.signal.aborted) return;
		const text = normalizeTranscript(word.text);
		if (word.kind === "commit") {
			primary.liveDraft = undefined;
			live.transcript.commit(text);
		} else if (!live.stopping) {
			primary.liveDraft = text || undefined;
		}
	}, decoder.signal);
	decoder.signal.throwIfAborted();
	const { traits } = decoder.recognizer;
	const device = traits.boundDevice;
	const identity = device ? [device.label, device.id].filter(Boolean).join(" / ") : "device unknown";
	const route = streaming && traits.stream ? "native streaming" : "final-only delivery";
	operation.context.ui.notify(`Micme loaded ${route} · compute ${traits.actualCompute} · ${sanitizeTerminalOutput(identity.replace(/\p{Bidi_Control}/gu, ""))}`, "info");
}

function createLiveSession(ctx: ExtensionContext, decoder: PcmDecoder): LiveSession {
	return { decoder, transcript: new LiveTranscript(ctx), startedAt: performance.now(), peakLag: 0, level: 0, lastPcmAt: 0, stopping: false };
}

async function startStreamingTranscription(owner: MicmeSessionOwner, operation: MicmeOperation, ctx: ExtensionContext) {
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
	const live = createLiveSession(ctx, worker);
	live.legacy = { worker, child, finalizeWithClip: plan.finalizeWithClip };
	operation.live = live;
	operation.modelId = getWhisperCppModelNameFromPath(plan.modelPath) ?? null;
	operation.language = plan.language === "auto" ? null : plan.language;
	const ready = await worker.ready;
	worker.signal.throwIfAborted();
	if (envFlag("MICME_STREAM_DIAGNOSTICS")) {
		ctx.ui.notify(`Micme live model load: ${Math.round(ready.loadMs)} ms (ASR ${ready.asrLoads}, VAD ${ready.vadLoads})`, "info");
	}

	await startLiveSession(owner, operation, live);
}

async function startLiveSession(owner: MicmeSessionOwner, operation: MicmeOperation, live: LiveSession) {
	const { decoder } = live;
	operation.context.ui.setStatus(STATUS_KEY, "waiting for live audio… (/micme cancel)");
	live.captureStartup = startLiveCapture(owner, operation, live);
	const active = await live.captureStartup;
	decoder.signal.throwIfAborted();
	if (operation.phase !== "starting") return;
	decoder.signal.addEventListener("abort", () => owner.failLiveRecording(operation, decoder.failure), { once: true });
	owner.activateRecording(operation, "streaming", active);
}

async function startLiveCapture(owner: MicmeSessionOwner, operation: MicmeOperation, live: LiveSession) {
	const { decoder } = live;
	const directory = await owner.allocateRecordingDirectory(operation, "micme-stream-", true);
	if (!owner.isCurrent(operation)) await cleanupRecordingDirectory(owner, operation, directory);
	decoder.signal.throwIfAborted();
	const audioPath = join(directory.filesPath, "raw.wav");
	const command = await buildLiveRecorderCommand(audioPath, directory, decoder.signal);
	decoder.signal.throwIfAborted();
	const active = spawnRecording(command, audioPath, directory.path, directory);
	active.audioLevel = () => performance.now() - live.lastPcmAt < 250 ? live.level : 0;
	active.livePcmMeter = true;
	operation.primary = active;
	operation.processes.add(active);
	operation.capture = initialCapture(command.capture?.source ?? "builtin", command.capture?.requested);
	live.startedAt = performance.now();
	void active.exitObserved.then((exit) => {
		if (operation.phase === "starting") decoder.fail(new EarlyRecorderExitError(exit, active, true));
	});
	const timer = setTimeout(() => {
		decoder.fail(new Error("Micme timed out waiting for live PCM. Check the microphone or configure a growing 16 kHz mono signed 16-bit PCM WAV recorder."));
	}, decoder.timeoutMs);
	try {
		const reader = await openCaptureReader(operation, active, directory, decoder.signal);
		operation.reader = reader;
		owner.publishCapture(operation, { ...operation.capture, stage: "waiting" });
		const first = await firstLivePcm(live, reader);
		decoder.signal.throwIfAborted();
		if (first) {
			publishLiveBlock(owner, operation, live, first.pcm);
			if (!live.stopping) owner.showRecordingWidget(operation, active);
			live.pump = pumpLivePcm(owner, operation, live, reader, first).catch((error: unknown) => decoder.fail(error));
		}
		return active;
	} catch (error) {
		throw decoder.failure ?? error;
	} finally {
		clearTimeout(timer);
	}
}

async function openCaptureReader(operation: MicmeOperation, active: Recording, directory: RecordingDirectory, inference: AbortSignal) {
	// While waiting for the file, inference can abort startup. Once opened,
	// only cancellation/teardown may revoke the held capture descriptor.
	inference.throwIfAborted();
	const startup = new AbortController();
	const cancelWait = () => startup.abort(inference.reason);
	inference.addEventListener("abort", cancelWait, { once: true });
	try {
		const signal = AbortSignal.any([operation.controller.signal, startup.signal]);
		return await openLivePcm(active.audioPath, directory, signal, active);
	} finally {
		inference.removeEventListener("abort", cancelWait);
	}
}

async function firstLivePcm(live: LiveSession, reader: LivePcmReader) {
	while (!live.stopping) {
		live.decoder.signal.throwIfAborted();
		const block = await reader.read(false);
		if (block.pcm.length) return block;
		if (!live.stopping) await livePoll(live.decoder.signal);
	}
	// A normal stop can precede first samples. Validate the closed WAV in final drain.
	return undefined;
}

function publishLiveBlock(owner: MicmeSessionOwner, operation: MicmeOperation, live: LiveSession, pcm: Buffer) {
	if (!pcm.length || live.stopping || live.decoder.signal.aborted) return;
	live.level = pcm16BufferLevel(pcm);
	live.lastPcmAt = performance.now();
	owner.publishCapture(operation, noteLiveBlock(operation.capture, pcm, live.lastPcmAt - live.startedAt));
}

async function pumpLivePcm(owner: MicmeSessionOwner, operation: MicmeOperation, live: LiveSession, reader: LivePcmReader, first: Awaited<ReturnType<LivePcmReader["read"]>>) {
	const { decoder } = live;
	let block = first;
	for (;;) {
		decoder.signal.throwIfAborted();
		if (block.pcm.length) {
			// A block read concurrently with stop still feeds before final drain.
			const preview = !live.stopping && caughtUpForLivePreview(block.availableThrough, decoder.through);
			live.peakLag = Math.max(live.peakLag, block.availableThrough - decoder.through);
			await decoder.send(block.pcm, preview);
		}
		if (live.stopping) return;
		if (!block.pcm.length) {
			await livePoll(decoder.signal);
			if (live.stopping) return;
		}
		block = await reader.read(false);
		publishLiveBlock(owner, operation, live, block.pcm);
	}
}

async function stopAndTranscribe(owner: MicmeSessionOwner, operation: MicmeOperation, failure: unknown) {
	const active = operation.primary;
	if (!active) throw new Error("Micme lost ownership of its recording process.");
	if (operation.live) await stopStreamingTranscription(owner, operation, active, operation.live, failure);
	else await stopClipAndTranscribe(owner, operation, active);
}

async function stopClipAndTranscribe(owner: MicmeSessionOwner, operation: MicmeOperation, active: Recording) {
	let errorStage: Capture["stage"] = "device-failed";
	let final: Final | undefined;
	try {
		await stopRecorder(active);
		await operation.clipObservation;
		if (!owner.isCurrent(operation)) return;
		owner.transition(operation, "transcribing");
		owner.publishCapture(operation, { ...operation.capture, stage: "processing" });
		errorStage = "asr-failed";
		if (operation.engine) {
			if (!active.directory) throw new Error("Micme lost the owned recording directory.");
			operation.reader = await openCaptureReader(operation, active, active.directory, operation.engine.decoder.signal);
			final = await finishArtifact(owner, operation, operation.reader);
		} else {
			const raw = normalizeTranscript(await transcribeRecordingClip(owner, operation, active));
			if (!owner.isCurrent(operation)) return;
			if (operation.trial) {
				await reviewTrial(operation, raw);
				return;
			}
			const { finishLocal } = await import("./transfer/language.ts");
			operation.controller.signal.throwIfAborted();
			const language = getTranslateToEnglishLanguage() ?? env("MICME_LANGUAGE")?.trim();
			final = finishLocal(raw, language && language !== "auto" ? language : null, "clip");
		}
		if (!final.local) {
			errorStage = "no-speech";
			throw new Error("Micme did not receive any transcript text. Check the input and selected language.");
		}
	} catch (error) {
		await abortArtifact(operation, error);
		if (!owner.isCurrent(operation)) return;
		if (error instanceof Error && error.message.startsWith("Micme recorded almost-silent audio")) errorStage = "no-speech";
		owner.publishCapture(operation, { ...operation.capture, stage: errorStage });
		const canRetry = Boolean(operation.engine && operation.reader && errorStage === "asr-failed");
		const audio = operation.history || canRetry ? await verifiedRecording(owner, operation) : null;
		if (canRetry && audio && owner.isCurrent(operation)) {
			const recovered = await offerArtifactRetry(operation, audio, "clip");
			if (recovered?.local && owner.isCurrent(operation)) {
				await deliverTranscribedClip(owner, operation, recovered);
				return;
			}
		}
		await saveOperationTake(operation, final ?? null, "asr-failed", audio);
		throw withKeptAudio(error, await settleRecordedAudio(owner, operation, operation.trial ? "delivered" : "failed"));
	} finally {
		if (operation.trial && owner.isCurrent(operation)) await settleRecordedAudio(owner, operation, "delivered");
	}
	if (owner.isCurrent(operation)) await deliverTranscribedClip(owner, operation, final);
}

async function stopStreamingTranscription(owner: MicmeSessionOwner, operation: MicmeOperation, active: Recording, live: LiveSession, failure: unknown) {
	const ctx = operation.context;
	const { decoder, legacy } = live;
	live.stopping = true;
	let final: Final;
	let replace = false;
	let stage: Capture["stage"] = failure instanceof EarlyRecorderExitError || failure === undefined ? "device-failed" : "asr-failed";
	try {
		if (failure !== undefined) throw failure;
		const reader = operation.reader;
		if (!reader) throw new Error("Micme lost its verified PCM reader.");
		const exit = await stopProcess(active);
		assertExpectedProcessExit(active, exit, "recorder");
		stage = "asr-failed";
		decoder.signal.throwIfAborted();
		owner.transition(operation, "finalizing");
		owner.publishCapture(operation, { ...operation.capture, stage: "processing" });
		await live.captureStartup;
		await live.pump;
		if (legacy) {
			const done = await finishLiveWorker(legacy.worker, reader);
			await stopProcess(legacy.child); // Release the supervisor and any inherited workers.
			decoder.signal.throwIfAborted();
			if (envFlag("MICME_STREAM_DIAGNOSTICS")) {
				const firstDraft = live.firstDraftAt === undefined ? "none" : `${Math.round(live.firstDraftAt - live.startedAt)} ms`;
				ctx.ui.notify(`Micme live: first draft ${firstDraft}; ${done.through} samples, peak lag ${live.peakLag} samples, ${done.vadFrames} VAD frames, ${done.asrCalls} ASR calls in ${Math.round(done.asrMs)} ms`, "info");
			}
			const confirmed = live.transcript.text;
			let text = confirmed;
			if (confirmed && legacy.finalizeWithClip) {
				try {
					text = await refineLiveTranscript(operation, reader, done.through);
					replace = true;
				} catch (error) {
					await reportRefinementFailure(owner, operation, confirmed, error);
					return;
				}
			}
			final = { raw: text, local: text, language: operation.language ?? null, source: "live", rules: [] };
		} else {
			final = await finishArtifact(owner, operation, reader);
			replace = !live.transcript.text || final.raw !== live.transcript.text;
		}
	} catch (error) {
		await handleLiveFailure(owner, operation, live, stage, error);
		return;
	}

	if (!owner.isCurrent(operation)) return;
	try {
		if (!final.local) {
			owner.publishCapture(operation, { ...operation.capture, stage: "no-speech" });
			ctx.ui.notify("Micme did not recognize any words in the live stream.", "warning");
			const audio = operation.history ? await verifiedRecording(owner, operation) : null;
			await saveOperationTake(operation, null, "asr-failed", audio);
		} else {
			// New local language rules may change replay, but never rewrite a live commit.
			const editorText = !legacy && live.transcript.text ? final.raw : final.local;
			await deliverLiveFinal(owner, operation, final, editorText, replace);
		}
	} finally {
		if (owner.isCurrent(operation)) await settleRecordedAudio(owner, operation, "delivered");
	}
}

async function reportRefinementFailure(owner: MicmeSessionOwner, operation: MicmeOperation, confirmed: string, error: unknown) {
	if (!owner.isCurrent(operation)) return;
	const final: Final = { raw: confirmed, local: confirmed, language: operation.language ?? null, source: "live", rules: [] };
	owner.rememberTranscript(operation, confirmed);
	const audio = operation.history ? await verifiedRecording(owner, operation) : null;
	const row = await saveOperationTake(operation, final, "asr-failed", audio);
	owner.rememberLive(operation, final, row);
	const kept = await settleRecordedAudio(owner, operation, "failed");
	const message = sanitizeTerminalOutput(withKeptAudio(error, kept).message);
	operation.context.ui.notify(`Micme saved the confirmed live transcript for /micme last because final clip refinement failed: ${message}`, "warning");
}

async function handleLiveFailure(owner: MicmeSessionOwner, operation: MicmeOperation, live: LiveSession, stage: Capture["stage"], error: unknown) {
	live.decoder.fail(error);
	await stopOwnedProcesses(operation);
	await live.pump;
	if (!owner.isCurrent(operation)) return;
	owner.publishCapture(operation, { ...operation.capture, stage });
	const audio = await verifiedRecording(owner, operation);
	if (!owner.isCurrent(operation)) return;
	const confirmed = live.transcript.text;
	if (confirmed) owner.rememberTranscript(operation, confirmed);
	if (audio && stage === "asr-failed" && operation.engine) {
		const recovered = await offerArtifactRetry(operation, audio, "live");
		if (!owner.isCurrent(operation)) return;
		if (recovered?.local) {
			// A recovered final must not rewrite committed words or submit their
			// replacement. RPC's live destination remains explicit replay.
			try {
				await deliverLiveFinal(owner, operation, recovered, recovered.local, true, Boolean(confirmed));
			} finally {
				if (owner.isCurrent(operation)) await settleRecordedAudio(owner, operation, "delivered");
			}
			return;
		}
	}
	await saveOperationTake(operation, null, "asr-failed", audio);
	throw withKeptAudio(recordingError(operation, error), await settleRecordedAudio(owner, operation, "failed"));
}

async function offerArtifactRetry(operation: MicmeOperation, audio: VerifiedAudio, source: "clip" | "live") {
	const { context: ctx, controller: { signal }, engine } = operation;
	if (!engine || ctx.mode !== "tui" || signal.aborted) return;
	if (!await ctx.ui.confirm("Micme recognition failed", "The complete recording was verified. Retry this audio with the same model?", { signal })) return;
	if (signal.aborted) return;
	// The recorder and failed engine have stopped. Do not block a queued
	// retry behind the same take's foreground reservation.
	releaseForeground(operation);
	try {
		const { recognizeVerifiedRetry } = await import("./transfer/recognition.ts");
		signal.throwIfAborted();
		const final = await recognizeVerifiedRetry(audio, engine.choice, ignoreRetryProgress, signal, () => {
			signal.throwIfAborted();
			ctx.ui.notify("Micme is retrying the verified recording on CPU after the fresh Auto attempt failed.", "warning");
		});
		return { ...final, source };
	} catch {
		if (!signal.aborted) ctx.ui.notify("Micme could not recognize the verified recording on retry.", "warning");
	}
}

function ignoreRetryProgress() { /* The pending foreground take owns status. */ }

async function finishLiveWorker(worker: LiveWorker, reader: LivePcmReader) {
	const timer = setTimeout(() => worker.fail(new Error("Micme timed out draining the final live PCM.")), worker.timeoutMs);
	try {
		await drainPcm(reader, worker);
		return await worker.finish();
	} finally {
		clearTimeout(timer);
	}
}

async function finishArtifact(owner: MicmeSessionOwner, operation: MicmeOperation, reader: LivePcmReader): Promise<Final> {
	const decoder = operation.engine?.decoder;
	if (!decoder?.recognizer) throw new Error("Micme lost its selected recognizer.");
	const timer = setTimeout(() => decoder.fail(new Error("Micme timed out finalizing the selected recognizer.")), decoder.timeoutMs);
	try {
		await drainPcm(reader, decoder);
		const source = operation.live ? "live" : "clip";
		if (decoder.through === 0) {
			await abortArtifact(operation, new Error("Micme capture contained no samples."));
			return { raw: "", local: "", language: null, source, rules: [] };
		}
		const verified = await verifiedRecording(owner, operation);
		decoder.signal.throwIfAborted();
		if (!verified) throw new Error("Micme could not verify the complete recording for local recognition.");
		const final = await decoder.recognizer.finish(verified, decoder.signal);
		decoder.signal.throwIfAborted();
		return { ...final, source };
	} finally {
		clearTimeout(timer);
	}
}

async function drainPcm(reader: LivePcmReader, decoder: PcmDecoder) {
	for (;;) {
		decoder.signal.throwIfAborted();
		const block = await reader.read(true);
		if (!block.pcm.length) {
			if (block.availableThrough !== decoder.through) throw new Error("Micme did not acknowledge all captured PCM samples.");
			return;
		}
		await decoder.send(block.pcm, false);
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
async function settleRecordedAudio(owner: MicmeSessionOwner, operation: MicmeOperation, outcome: AudioOutcome) {
	const kept = outcome === "failed" || operation.keepAudio ? await findCapturedAudio(operation, outcome) : undefined;
	if (kept?.path) owner.rememberAudioDirectory(operation, kept.path);
	// Leave the reader open through retention checks, but release its handle before deleting the spool.
	if (!kept) operation.reader?.close();
	const removable = [...operation.directories].filter((directory) => directory !== kept?.directory);
	await Promise.all(removable.map((directory) => cleanupRecordingDirectory(owner, operation, directory)));
	return kept;
}

async function findCapturedAudio(operation: MicmeOperation, outcome: AudioOutcome): Promise<KeptAudio | undefined> {
	const recording = operation.primary;
	if (!recording?.directory) return;
	const { directory } = recording;
	const { live, reader } = operation;
	try {
		if (reader) {
			if (!await reader.hasRetainableCapture()) return;
		} else {
			// Preserve the existing partial-file diagnostic for recorder startup failures before a reader was acquired.
			if (live && outcome !== "failed") return;
			if (!directory.hasRegularFile(recording.audioPath, MIN_AUDIO_BYTES)) return;
		}
		const path = live ? directory.verifiedDisplayPath() : directory.path;
		return path
			? { note: "Audio kept for debugging", path, directory }
			: { note: "Micme left the recording directory untouched but could not confirm its location.", directory };
	} catch {
		// Failed inspection is not proof that the directory is safe to delete.
		return live
			? { note: "Micme left the recording directory untouched but could not verify retained audio.", directory }
			: { note: "Audio may remain in", path: directory.path, directory };
	}
}

function withKeptAudio(error: unknown, kept: KeptAudio | undefined) {
	const message = error instanceof Error ? error.message : String(error);
	if (!kept) return error instanceof Error ? error : new Error(message);
	const note = kept.path ? `${kept.note}: ${sanitizeTerminalOutput(kept.path)}` : kept.note;
	return new Error(`${message}\n${note}`, { cause: error });
}

function recordingError(operation: MicmeOperation, error: unknown) {
	// Hook exit observation can precede the bounded stderr drain.
	if (error instanceof EarlyRecorderExitError) return error.withDiagnostics();
	const child = operation.live?.legacy?.child;
	const stderr = child && liveWorkerDiagnostics(child);
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
	if (operation.trial) {
		if (!directory) throw new Error("Micme Try It lost its temporary recording directory.");
		return transcribeTrial(operation.trial.installed, preparedAudioPath, directory, signal);
	}
	return transcribe(preparedAudioPath, filesPath, ctx, signal, directory);
}

async function verifiedRecording(owner: MicmeSessionOwner, operation: MicmeOperation) {
	if (operation.verified !== undefined) return operation.verified;
	const { primary, controller: { signal }, reader, context } = operation;
	if (!primary || !owner.isCurrent(operation)) return null;
	try {
		const target = await createLiveRecordingDirectory(context.cwd, false, "micme-verified-");
		operation.directories.add(target);
		if (!owner.isCurrent(operation)) return null;
		operation.verified = await freezeAudio(primary, reader ?? null, signal, target);
		return operation.verified;
	} catch {
		return null;
	}
}

async function saveOperationTake(operation: MicmeOperation, final: Final | null, state: Row["state"], audio: VerifiedAudio | null, polished?: string | null) {
	if (!operation.history || operation.controller.signal.aborted) return null;
	return saveDictation(operation.context, operation.controller.signal, operation.live ? "live" : "clip", final, state, audio, operation.modelId, polished);
}

async function deliverTranscribedClip(owner: MicmeSessionOwner, operation: MicmeOperation, final: Final) {
	const { context: ctx, selection, controller: { signal } } = operation;
	owner.rememberTranscript(operation, final.local);
	showRuleOutcomes(ctx, final);
	let row: EntryId | null = null;
	try {
		const prepared = selection ? await preparePolish(final, selection, signal) : null;
		if (!owner.isCurrent(operation)) return;
		if (operation.history) row = await saveOperationTake(operation, final, "ready", await verifiedRecording(owner, operation), prepared?.polished);
		if (!owner.isCurrent(operation)) return;
		let text = final.local;
		if (selection && prepared) {
			const { processFinal } = await import("./transfer/process-final.ts");
			signal.throwIfAborted();
			const output = await processFinal(final, { mode: "pending-clip", prepared, row }, selection, signal).catch(() => {
				signal.throwIfAborted();
				throw new Error("Micme final processing failed. Use /micme last for the original transcript.");
			});
			if (!owner.isCurrent(operation) || (output.kind === "suppressed" && output.reason === "cancel")) return;
			showProcessingWarnings(ctx, output.warnings);
			text = output.kind === "candidate" ? normalizeTranscript(output.text) : "";
			if (!text) {
				ctx.ui.notify("Micme output was empty; nothing was delivered. /micme last replays the original.", "info");
				return;
			}
		}
		owner.deliverClip(operation, text);
	} catch (error) {
		if (owner.isCurrent(operation)) await reportDeliveryFailure(owner, operation, row, error);
	} finally {
		if (owner.isCurrent(operation)) await settleRecordedAudio(owner, operation, "delivered");
	}
}

async function deliverLiveFinal(owner: MicmeSessionOwner, operation: MicmeOperation, final: Final, text: string, replace: boolean, reviewOnly = false) {
	owner.rememberTranscript(operation, final.local);
	showRuleOutcomes(operation.context, final);
	const audio = operation.history ? await verifiedRecording(owner, operation) : null;
	const row = await saveOperationTake(operation, final, "ready", audio);
	if (!owner.isCurrent(operation)) return;
	owner.rememberLive(operation, final, row);
	if (reviewOnly && operation.context.mode === "tui") {
		await showTakeReview(operation.context, "Recovered take · Review only", final.local, operation.controller.signal);
		return;
	}
	try {
		owner.deliverLive(operation, text, replace);
	} catch (error) {
		await reportDeliveryFailure(owner, operation, row, error);
	}
}

async function reportDeliveryFailure(owner: MicmeSessionOwner, operation: MicmeOperation, row: EntryId | null, error: unknown) {
	owner.publishCapture(operation, { ...operation.capture, stage: "delivery-failed" });
	await markDeliveryFailed(operation.context, operation.controller.signal, row);
	const message = error instanceof Error ? error.message : String(error);
	throw new Error(`Micme could not deliver the transcript: ${message}`, { cause: error });
}

function holdForeground(setForeground: SetForeground) {
	if (foregroundTakes === 0) setForeground(true);
	foregroundTakes++;
	return () => { if (--foregroundTakes === 0) setForeground(false); };
}

function releaseForeground(operation: MicmeOperation) {
	const release = operation.foreground;
	operation.foreground = undefined;
	release?.();
}

function clearLiveDraft(operation: MicmeOperation) {
	if (operation.primary) operation.primary.liveDraft = undefined;
}

async function stopOwnedProcesses(operation: MicmeOperation) {
	await Promise.all([...operation.processes].map((active) => stopProcess(active).catch(() => undefined)));
	await abortArtifact(operation, new Error("Micme stopped the selected recognizer."));
}

async function abortArtifact(operation: MicmeOperation, error: unknown) {
	const engine = operation.engine;
	if (!engine) return;
	engine.decoder.fail(error);
	if (engine.decoder.recognizer) {
		engine.abort ??= engine.decoder.recognizer.abort().catch(() => undefined);
		await engine.abort;
	}
}

function closeRecordingResources(operation: MicmeOperation) {
	operation.reader?.close();
	for (const directory of operation.directories) directory.close();
	operation.directories.clear();
}

async function cleanupRecordingDirectory(owner: MicmeSessionOwner, operation: MicmeOperation, directory: RecordingDirectory) {
	try {
		await directory.remove();
	} catch (error) {
		if (!owner.isCurrent(operation)) return;
		const message = sanitizeTerminalOutput(error instanceof Error ? error.message : String(error)) || "unknown error";
		let detail = "";
		if (!operation.live) {
			owner.rememberAudioDirectory(operation, directory.path);
			detail = `\nAudio may remain in: ${sanitizeTerminalOutput(directory.path)}`;
		}
		operation.context.ui.notify(`Micme could not clean up the recording directory: ${message}${detail}`, "warning");
	}
}

function createGuardedContext(ctx: ExtensionContext, isCurrent: () => boolean, readOnly = false) {
	const guardedUi = new Proxy(ctx.ui, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			if (!GUARDED_UI_METHODS.has(String(property))) return value.bind(target);
			return (...args: unknown[]) => isCurrent() && !(readOnly && EDITOR_WRITE_METHODS.has(String(property)))
				? Reflect.apply(value, target, args) as unknown : undefined;
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
