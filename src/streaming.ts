import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MAX_CAPTURED_OUTPUT_CHARS,
	STREAM_MIN_INITIAL_WORDS,
} from "./constants.ts";
import {
	env,
	envFlag,
	getStreamKeepContext,
	getStreamKeepMs,
	getStreamLengthMs,
	getStreamMaxTokens,
	getStreamStepMs,
	getStreamVadThreshold,
	getStreamWordsPerChunk,
} from "./config.ts";
import { pasteOrSubmitTranscript } from "./transcript-delivery.ts";
import { shellQuote } from "./processes.ts";
import type { CommandSpec, Recording, StreamingState } from "./types.ts";

export function buildWhisperStreamCommand(binary: string, modelPath: string, tempDir: string): CommandSpec {
	const args = [
		"-m",
		modelPath,
		"--step",
		String(getStreamStepMs()),
		"--length",
		String(getStreamLengthMs()),
		"--keep",
		String(getStreamKeepMs()),
		"--max-tokens",
		String(getStreamMaxTokens()),
		"--vad-thold",
		String(getStreamVadThreshold()),
		"-nf",
	];

	if (getStreamKeepContext()) args.push("--keep-context");

	const capture = env("MICME_STREAM_CAPTURE");
	if (capture?.trim()) args.push("--capture", capture.trim());

	const language = env("MICME_LANGUAGE");
	if (language?.trim()) args.push("-l", language.trim());

	return { command: binary, args, display: `${binary} ${args.map(shellQuote).join(" ")}` };
}

export function handleStreamingOutput(ctx: ExtensionContext, active: Recording, chunk: string) {
	drainStreamingOutput(ctx, active, false, chunk);
}

export function drainStreamingOutput(ctx: ExtensionContext, active: Recording, force: boolean, chunk = "") {
	if (!active.streaming) return;
	for (const part of readStreamingOutputFrames(active.streaming, chunk, force)) {
		const text = sanitizeStreamingText(part);
		if (!text) {
			if (shouldResetStreamingPending(part)) {
				active.streaming.pendingWords = [];
				renderStreamingPreview(ctx, active.streaming, false);
			}
			continue;
		}
		if (!active.streaming.firstOutputAt) active.streaming.firstOutputAt = Date.now();
		const next = diffStreamingText(active.streaming.emittedWords.slice(-160).join(" "), text);
		active.streaming.lastText = text;
		if (!next) {
			active.streaming.pendingWords = [];
			renderStreamingPreview(ctx, active.streaming, false);
			continue;
		}
		active.audioLevel = () => 0.55;
		queueStableStreamingWords(ctx, active.streaming, splitStreamingWords(next));
	}
}

export function readStreamingOutputFrames(state: StreamingState, chunk: string, force: boolean) {
	// whisper-stream rewrites one terminal line with \r; wait for delimiters so split stdout chunks do not become words.
	state.outputBuffer = `${state.outputBuffer}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
	const frames: string[] = [];

	while (true) {
		const match = state.outputBuffer.match(/[\r\n]/);
		if (!match || match.index === undefined) break;
		frames.push(state.outputBuffer.slice(0, match.index));
		state.outputBuffer = state.outputBuffer.slice(match.index + 1).replace(/^[\r\n]+/, "");
	}

	if (force && state.outputBuffer.trim()) {
		frames.push(state.outputBuffer);
		state.outputBuffer = "";
	}

	return frames;
}

export function sanitizeStreamingText(text: string) {
	const cleaned = stripStreamingControls(text)
		.replace(/<\|[^|]*\|>/g, " ")
		.replace(/^\s*#+\s*Transcription\s+\d+\s+END\s*$/i, " ")
		.replace(/\[[^\]]*\]/g, " ")
		.replace(/\([^)]*\)/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return isLikelyStreamingHallucination(cleaned) ? "" : cleaned;
}

export function stripStreamingControls(text: string) {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ").replace(/\s+/g, " ").trim();
}

export function diffStreamingText(previous: string, current: string) {
	const previousWords = splitStreamingWords(previous);
	const currentWords = splitStreamingWords(current);
	if (currentWords.length === 0) return "";
	const overlap = streamingWordOverlap(previousWords, currentWords);
	return currentWords.slice(overlap).join(" ");
}

export function isLikelyStreamingHallucination(text: string) {
	if (!text) return true;
	const normalized = text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
	if (/^(?:start speaking|blank audio)$/i.test(normalized)) return true;
	if (/^(?:you|yeah|okay|ok|uh|um|hmm)$/i.test(normalized)) return true;
	if (/^(?:thank you|thanks for watching|thank you very much)$/i.test(normalized)) return true;
	return false;
}

export function shouldResetStreamingPending(text: string) {
	const cleaned = stripStreamingControls(text);
	if (!cleaned) return false;
	if (isLikelyStreamingHallucination(cleaned)) return true;
	return /^\[[^\]]+\]$/.test(cleaned) || /^\([^)]*\)$/.test(cleaned);
}

export function queueStableStreamingWords(ctx: ExtensionContext, state: StreamingState, currentWords: string[]) {
	// Popular Whisper streaming frontends use local agreement: show/commit only the common prefix of consecutive hypotheses.
	const stableCount = commonStreamingPrefixLength(state.pendingWords, currentWords);
	const maxConfirmed = state.emittedWords.length === 0 && currentWords.length < STREAM_MIN_INITIAL_WORDS ? 0 : stableCount;
	const confirmedCount = Math.min(maxConfirmed, getStreamWordsPerChunk());
	if (confirmedCount > 0) queueStreamingWords(state, currentWords.slice(0, confirmedCount));
	state.pendingWords = currentWords.slice(confirmedCount);
	renderStreamingPreview(ctx, state, false);
}

export function flushPendingStreamingWords(ctx: ExtensionContext, state: StreamingState) {
	if (state.pendingWords.length > 0) {
		queueStreamingWords(state, state.pendingWords);
		state.pendingWords = [];
	}
	renderStreamingPreview(ctx, state, true);
}

export function queueStreamingWords(state: StreamingState, words: string[]) {
	const nextWords = words.filter(Boolean);
	if (nextWords.length === 0) return;
	state.emittedWords.push(...nextWords);
}

export function splitStreamingWords(text: string) {
	return text.split(/\s+/).filter(Boolean);
}

export function streamingWordOverlap(previousWords: string[], currentWords: string[]) {
	let overlap = 0;
	const maxOverlap = Math.min(previousWords.length, currentWords.length);
	for (let size = 1; size <= maxOverlap; size++) {
		if (streamingWordsEqual(previousWords.slice(-size), currentWords.slice(0, size))) {
			overlap = size;
		}
	}
	return overlap;
}

export function commonStreamingPrefixLength(previousWords: string[], currentWords: string[]) {
	const maxPrefix = Math.min(previousWords.length, currentWords.length);
	let count = 0;
	while (count < maxPrefix && normalizeStreamingWord(previousWords[count] ?? "") === normalizeStreamingWord(currentWords[count] ?? "")) {
		count++;
	}
	return count;
}

export function streamingWordsEqual(left: string[], right: string[]) {
	if (left.length !== right.length) return false;
	return left.every((word, index) => normalizeStreamingWord(word) === normalizeStreamingWord(right[index] ?? ""));
}

export function normalizeStreamingWord(word: string) {
	const normalized = word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
	return normalized || word.toLowerCase();
}

export function getStreamingTranscript(state: StreamingState) {
	return [...state.emittedWords, ...state.pendingWords].join(" ");
}

export function renderStreamingPreview(ctx: ExtensionContext, state: StreamingState, trailingSpace: boolean) {
	const transcript = getStreamingTranscript(state);
	const suffix = transcript ? `${transcript}${trailingSpace ? " " : ""}` : "";
	const nextText = `${state.baseText}${suffix}`;
	if (nextText === state.previewText) return;
	ctx.ui.setEditorText(nextText);
	state.previewText = nextText;
	if (transcript && !state.firstPreviewAt) {
		state.firstPreviewAt = Date.now();
		if (envFlag("MICME_STREAM_DIAGNOSTICS")) {
			ctx.ui.notify(`Micme stream first preview: ${state.firstPreviewAt - state.startedAt} ms`, "info");
		}
	}
}

export function showStreamingDiagnostics(ctx: ExtensionContext, state: StreamingState) {
	if (!envFlag("MICME_STREAM_DIAGNOSTICS")) return;
	const firstOutput = state.firstOutputAt ? `${state.firstOutputAt - state.startedAt} ms` : "none";
	const firstPreview = state.firstPreviewAt ? `${state.firstPreviewAt - state.startedAt} ms` : "none";
	ctx.ui.notify(`Micme stream timings: first output ${firstOutput}, first preview ${firstPreview}`, "info");
}

export async function pasteOrSubmitFinalStreamingTranscript(ctx: ExtensionContext, pi: ExtensionAPI, state: StreamingState, transcript: string) {
	if (envFlag("MICME_AUTO_SUBMIT")) {
		ctx.ui.setEditorText(state.baseText);
		await pasteOrSubmitTranscript(ctx, pi, transcript);
		return;
	}

	const suffix = /\s$/.test(transcript) ? transcript : `${transcript} `;
	const nextText = `${state.baseText}${suffix}`;
	ctx.ui.setEditorText(nextText);
	state.previewText = nextText;
}

export function clearStreamingFlush(state: StreamingState) {
	if (!state.flushTimer) return;
	clearTimeout(state.flushTimer);
	state.flushTimer = undefined;
}
