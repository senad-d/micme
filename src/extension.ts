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
} from "./config.ts";
import { buildRecorderCommand, listAudioDevices, prepareAudioForTranscription, registerDeviceMessageRenderer, validateRecordedAudio } from "./audio.ts";
import { installMicmeEditorFallback, type MicmeEditorInputHandlers } from "./editor.ts";
import { resolveTranscriptionPlan, formatTranscriptionPlan } from "./backends.ts";
import { ensureWhisperCppModel } from "./models.ts";
import {
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
import type { Recording } from "./types.ts";

const MICME_ACTIONS = ["devices", "conf", "last", "audio", "help"] as const;

const SHORTCUT_REPEAT_GUARD_MS = 1_000;

let recording: Recording | undefined;
let lastTranscript = "";
let lastAudioDir = "";
let lastShortcutInputAt = 0;

export default function micmeExtension(pi: ExtensionAPI) {
	reloadMicmeConfig();
	registerDeviceMessageRenderer(pi);

	async function toggle(ctx: ExtensionContext) {
		if (recording) {
			if (isStillStarting(recording)) return;
			await stopAndTranscribe(ctx, pi);
			return;
		}
		await startRecording(ctx);
	}

	pi.registerCommand("micme", {
		description: "Toggle local voice recording and paste the transcript into the editor",
		getArgumentCompletions: (prefix) => {
			const matches = MICME_ACTIONS.filter((action) => action.startsWith(prefix.trim().toLowerCase()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";

			try {
				switch (action) {
					case "":
						await toggle(ctx);
						return;
					case "devices":
						await listAudioDevices(ctx, pi);
						return;
					case "conf":
						await showConfiguration(ctx);
						return;
					case "last":
						await pasteOrSubmitTranscript(ctx, pi, lastTranscript);
						return;
					case "audio":
						ctx.ui.notify(lastAudioDir ? `Last Micme audio directory: ${sanitizeTerminalOutput(lastAudioDir)}` : "No kept Micme audio yet. Set MICME_KEEP_AUDIO=1.", "info");
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
		},
	});

	const terminalShortcut = getTerminalShortcut();
	if (terminalShortcut) {
		pi.registerShortcut(terminalShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Micme: toggle local voice recording",
			handler: async (ctx) => {
				try {
					if (isShortcutAutoRepeat()) return;
					await toggle(ctx);
				} catch (error) {
					handleExtensionError(ctx, error);
				}
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		reloadMicmeConfig();
		installMicmeEditorFallback(ctx, createMicmeEditorHandlers(ctx, toggle));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearRecordingWidget(ctx);
		if (!recording) return;
		const active = recording;
		recording = undefined;
		if (active.streaming) {
			clearStreamingFlush(active.streaming);
			await Promise.all([stopProcess(active).catch(() => undefined), active.clipRecording ? stopProcess(active.clipRecording).catch(() => undefined) : Promise.resolve()]);
		} else {
			await stopRecorder(active).catch(() => undefined);
		}
		await cleanup(active.tempDir).catch(() => undefined);
	});
}

function createMicmeEditorHandlers(ctx: ExtensionContext, toggle: (ctx: ExtensionContext) => Promise<void>): MicmeEditorInputHandlers {
	return {
		toggle: () => toggle(ctx).catch((error) => handleExtensionError(ctx, error)),
	};
}

function handleExtensionError(ctx: ExtensionContext, error: unknown) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify(sanitizeTerminalOutput(error instanceof Error ? error.message : String(error)) || "Micme failed with an empty error message.", "error");
}

function isStillStarting(active: Recording) {
	return Date.now() - active.startedAt < RECORDER_STARTUP_GRACE_MS;
}

function isShortcutAutoRepeat() {
	const now = Date.now();
	const repeated = now - lastShortcutInputAt < SHORTCUT_REPEAT_GUARD_MS;
	lastShortcutInputAt = now;
	return repeated;
}

function getHelpText() {
	const shortcut = sanitizeTerminalOutput(getShortcut()) || "not set";
	const actions = MICME_ACTIONS.filter((action) => action !== "help").join("|");
	return `Usage: /micme [${actions}]. Shortcut: ${shortcut} toggles recording; tap once to start, tap again to stop/transcribe.`;
}

async function startRecording(ctx: ExtensionContext, stopHint = getShortcut()) {
	if (recording) return;
	reloadMicmeConfig();

	if (getTranscriptionMode() === "stream") {
		await startStreamingTranscription(ctx, stopHint);
		return;
	}

	const tempDir = await createRecordingDirectory(ctx.cwd, envFlag("MICME_KEEP_AUDIO"), "micme-");
	let active: Recording | undefined;

	try {
		const audioPath = join(tempDir, "raw.wav");
		const command = buildRecorderCommand(audioPath);
		active = spawnRecording(command, audioPath, tempDir);
		recording = active;

		const earlyExit = await raceWithTimeout(active.exitPromise, RECORDER_STARTUP_GRACE_MS);
		if (earlyExit) {
			if (active.stopRequested) return;
			const stderr = formatProcessOutput(active.stderr());
			const suffix = stderr ? `\n${stderr}` : "";
			throw new Error(`Micme recorder exited early (${formatExit(earlyExit)}).${suffix}`);
		}

		ctx.ui.setStatus(STATUS_KEY, `● recording (${sanitizeTerminalOutput(stopHint) || "shortcut"} or /micme)`);
		startRecordingWidget(ctx, active);
	} catch (error) {
		await cleanupFailedRecordingStart(ctx, tempDir, active);
		throw error;
	}
}

async function cleanupFailedRecordingStart(ctx: ExtensionContext, tempDir: string, active: Recording | undefined) {
	if (active && recording === active) recording = undefined;
	clearRecordingWidget(ctx);
	if (active) {
		await stopProcess(active).catch(() => undefined);
		if (active.clipRecording) await stopProcess(active.clipRecording).catch(() => undefined);
	}
	await cleanup(tempDir).catch(() => undefined);
}

async function stopAndTranscribe(ctx: ExtensionContext, pi: ExtensionAPI) {
	const active = recording;
	if (!active) {
		ctx.ui.notify("Micme is not recording. Use /micme to start recording.", "warning");
		return;
	}

	if (active.streaming) {
		recording = undefined;
		clearRecordingWidget(ctx);
		await stopStreamingTranscription(ctx, pi, active);
		return;
	}

	recording = undefined;
	clearRecordingWidget(ctx);
	ctx.ui.setStatus(STATUS_KEY, "transcribing…");

	let completed = false;
	try {
		await stopRecorder(active);
		const preparedAudioPath = await prepareAudioForTranscription(active.audioPath, active.tempDir);
		await validateRecordedAudio(preparedAudioPath);
		const transcript = await transcribe(preparedAudioPath, active.tempDir, ctx);
		const normalized = normalizeTranscript(transcript);

		if (!normalized) {
			throw new Error("Micme did not receive any transcript text.");
		}

		lastTranscript = normalized;
		await pasteOrSubmitTranscript(ctx, pi, normalized);
		completed = true;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (envFlag("MICME_KEEP_AUDIO")) {
			lastAudioDir = active.tempDir;
		}
	} catch (error) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		lastAudioDir = active.tempDir;
		const message = sanitizeTerminalOutput(error instanceof Error ? error.message : String(error));
		throw new Error(`${message}\nAudio kept for debugging: ${sanitizeTerminalOutput(active.tempDir)}`);
	} finally {
		if (completed && !envFlag("MICME_KEEP_AUDIO")) {
			await cleanup(active.tempDir).catch(() => undefined);
		}
	}
}

async function startStreamingTranscription(ctx: ExtensionContext, stopHint = getShortcut()) {
	const plan = resolveTranscriptionPlan({ transcriptionMode: "stream" });
	if (plan.effectiveBackend !== "whisper.cpp" || !plan.binary || !plan.modelPath) {
		throw new Error(formatTranscriptionPlan(plan));
	}

	await ensureWhisperCppModel(plan.modelPath, ctx, { allowDownload: plan.modelDownloadable !== false });

	const tempDir = await createRecordingDirectory(ctx.cwd, envFlag("MICME_KEEP_AUDIO"), "micme-stream-");
	let active: Recording | undefined;

	try {
		const command = buildWhisperStreamCommand(plan.binary, plan.modelPath, tempDir);
		const clipAudioPath = getStreamFinalizeWithClip() ? join(tempDir, "raw.wav") : undefined;
		const clipCommand = clipAudioPath ? buildRecorderCommand(clipAudioPath) : undefined;
		active = spawnRecording(command, "", tempDir);
		const streamRecording = active;
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
		if (clipCommand && clipAudioPath) {
			streamRecording.clipRecording = spawnRecording(clipCommand, clipAudioPath, tempDir);
		}
		recording = streamRecording;

		streamRecording.process.stdout?.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			handleStreamingOutput(ctx, streamRecording, text);
		});

		const [earlyExit, recorderEarlyExit] = await Promise.all([
			raceWithTimeout(streamRecording.exitPromise, RECORDER_STARTUP_GRACE_MS),
			streamRecording.clipRecording ? raceWithTimeout(streamRecording.clipRecording.exitPromise, RECORDER_STARTUP_GRACE_MS) : Promise.resolve(undefined),
		]);
		if (earlyExit || recorderEarlyExit) {
			if (streamRecording.stopRequested || streamRecording.clipRecording?.stopRequested) return;
			const failed = earlyExit ? streamRecording : streamRecording.clipRecording;
			const stderr = failed ? formatProcessOutput(failed.stderr()) : "";
			const suffix = stderr ? `\n${stderr}` : "";
			throw new Error(`Micme streaming exited early (${formatExit(earlyExit ?? recorderEarlyExit!)}).${suffix}`);
		}

		ctx.ui.setStatus(STATUS_KEY, `● streaming (${sanitizeTerminalOutput(stopHint) || "shortcut"} or /micme)`);
		startRecordingWidget(ctx, streamRecording);
	} catch (error) {
		await cleanupFailedRecordingStart(ctx, tempDir, active);
		throw error;
	}
}

async function stopStreamingTranscription(ctx: ExtensionContext, pi: ExtensionAPI, active: Recording) {
	const state = active.streaming;
	let keepTempDir = false;
	const clipStopPromise = active.clipRecording ? stopRecorder(active.clipRecording).then(() => undefined, (error: unknown) => error) : undefined;

	if (state) {
		drainStreamingOutput(ctx, active, false);
		renderStreamingPreview(ctx, state, false);
		clearStreamingFlush(state);
	}

	await stopProcess(active);

	if (state) {
		drainStreamingOutput(ctx, active, true);
		showStreamingDiagnostics(ctx, state);
		if (!active.clipRecording) {
			flushPendingStreamingWords(ctx, state);
			const liveTranscript = normalizeTranscript(getStreamingTranscript(state));
			if (liveTranscript) {
				lastTranscript = liveTranscript;
				if (envFlag("MICME_AUTO_SUBMIT")) {
					ctx.ui.setEditorText(state.baseText);
					await pasteOrSubmitTranscript(ctx, pi, liveTranscript);
				}
			}
		} else {
			renderStreamingPreview(ctx, state, false);
		}
		clearStreamingFlush(state);
	}

	if (active.clipRecording && state) {
		ctx.ui.setStatus(STATUS_KEY, "finalizing stream…");
		try {
			const clipStopError = await clipStopPromise;
			if (clipStopError) throw clipStopError;
			const preparedAudioPath = await prepareAudioForTranscription(active.clipRecording.audioPath, active.tempDir);
			await validateRecordedAudio(preparedAudioPath);
			const transcript = await transcribe(preparedAudioPath, active.tempDir, ctx);
			const normalized = normalizeTranscript(transcript);
			if (!normalized) throw new Error("Micme did not receive any final transcript text.");

			lastTranscript = normalized;
			await pasteOrSubmitFinalStreamingTranscript(ctx, pi, state, normalized);
			if (envFlag("MICME_KEEP_AUDIO")) {
				lastAudioDir = active.tempDir;
				keepTempDir = true;
			}
		} catch (error) {
			flushPendingStreamingWords(ctx, state);
			const liveTranscript = normalizeTranscript(getStreamingTranscript(state));
			if (liveTranscript) lastTranscript = liveTranscript;
			lastAudioDir = active.tempDir;
			keepTempDir = true;
			const message = sanitizeTerminalOutput(error instanceof Error ? error.message : String(error));
			ctx.ui.notify(`Micme kept the live append-only stream transcript because final clip transcription failed: ${message}\nAudio kept for debugging: ${sanitizeTerminalOutput(active.tempDir)}`, "warning");
		}
	}

	if (!keepTempDir) await cleanup(active.tempDir).catch(() => undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}


