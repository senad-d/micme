import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_CAPTURED_OUTPUT_CHARS } from "./constants.ts";
import {
	env,
	envFlag,
	getTranslateToEnglishLanguage,
	getStreamFlushMs,
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
import { sanitizeTerminalText } from "./terminal-text.ts";
import type { CommandSpec, Recording, StreamingState } from "./types.ts";

export type StreamingFrameMode = "cumulative" | "incremental" | "rolling" | "duplicate" | "reset";

export type StreamingExtraction = {
	mode: StreamingFrameMode;
	newWords: string[];
};

type StreamingDiagnosticDetails = {
	rawFrame?: string;
	sanitizedText?: string;
	frameWords?: string[];
	extractionMode: StreamingFrameMode | "ignored" | "flush";
	newWords?: string[];
	reason?: string;
};

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

	const translateLanguage = getTranslateToEnglishLanguage();
	if (translateLanguage) {
		args.push("-tr", "-l", translateLanguage);
	} else {
		const language = env("MICME_LANGUAGE");
		if (language?.trim()) args.push("-l", language.trim());
	}

	return { command: binary, args, display: `${binary} ${args.map(shellQuote).join(" ")}` };
}

export function handleStreamingOutput(ctx: ExtensionContext, active: Recording, chunk: string) {
	drainStreamingOutput(ctx, active, false, chunk);
}

export function drainStreamingOutput(ctx: ExtensionContext, active: Recording, force: boolean, chunk = "") {
	if (!active.streaming) return;
	const state = active.streaming;

	for (const rawFrame of readStreamingOutputFrames(state, chunk, force)) {
		const sanitizedText = sanitizeStreamingText(rawFrame);
		const frameWords = splitStreamingWords(sanitizedText);

		if (!sanitizedText) {
			if (shouldResetStreamingPending(rawFrame)) {
				clearStreamingFlush(state);
				state.candidateWords = [];
				state.lastHypothesisWords = [];
				state.lastText = "";
				renderStreamingPreview(ctx, state, false);
				showStreamingFrameDiagnostics(ctx, state, {
					rawFrame,
					sanitizedText,
					frameWords,
					extractionMode: "reset",
					newWords: [],
					reason: "reset/hallucination frame",
				});
			} else {
				showStreamingFrameDiagnostics(ctx, state, {
					rawFrame,
					sanitizedText,
					frameWords,
					extractionMode: "ignored",
					newWords: [],
					reason: "empty frame",
				});
			}
			continue;
		}

		clearStreamingFlush(state);
		if (!state.firstOutputAt) state.firstOutputAt = Date.now();
		const extraction = extractStreamingCandidate(state, frameWords);
		state.lastText = sanitizedText;
		active.audioLevel = () => 0.55;
		queueStableStreamingWords(ctx, state, extraction.newWords, extraction.mode);
		state.lastHypothesisWords = frameWords;
		showStreamingFrameDiagnostics(ctx, state, {
			rawFrame,
			sanitizedText,
			frameWords,
			extractionMode: extraction.mode,
			newWords: extraction.newWords,
		});
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
	return sanitizeTerminalText(text);
}

export function diffStreamingText(previous: string, current: string) {
	const previousWords = splitStreamingWords(previous);
	const currentWords = splitStreamingWords(current);
	if (currentWords.length === 0) return "";
	const overlap = streamingWordOverlap(previousWords, currentWords);
	return currentWords.slice(overlap).join(" ");
}

export function extractStreamingCandidate(state: StreamingState, frameWords: string[]): StreamingExtraction {
	const words = frameWords.filter(Boolean);
	if (words.length === 0) return { mode: "reset", newWords: [] };

	const emittedOverlap = streamingWordOverlap(state.emittedWords.slice(-160), words);
	if (emittedOverlap === words.length) return { mode: "duplicate", newWords: [] };
	if (emittedOverlap > 0) return { mode: "cumulative", newWords: words.slice(emittedOverlap) };

	if (state.candidateWords.length > 0) {
		if (streamingWordsEqual(state.candidateWords, words)) return { mode: "duplicate", newWords: words };
		if (isStreamingWordsPrefix(state.candidateWords, words)) return { mode: "cumulative", newWords: words };
		if (streamingWordOverlap(state.candidateWords, words) > 0) return { mode: "rolling", newWords: words };
		if (looksLikeStreamingCorrection(state.candidateWords, words)) return { mode: "reset", newWords: words };
	}

	if (state.lastHypothesisWords.length > 0) {
		if (streamingWordsEqual(state.lastHypothesisWords, words)) return { mode: "duplicate", newWords: words };
		if (isStreamingWordsPrefix(state.lastHypothesisWords, words)) return { mode: "cumulative", newWords: trimCommittedStreamingPrefix(state, words) };
		if (streamingWordOverlap(state.lastHypothesisWords, words) > 0) return { mode: "rolling", newWords: words };
		if (looksLikeStreamingCorrection(state.lastHypothesisWords, words)) return { mode: "reset", newWords: words };
	}

	const isFirstHypothesis = state.emittedWords.length === 0 && state.candidateWords.length === 0 && state.lastHypothesisWords.length === 0;
	return { mode: isFirstHypothesis ? "cumulative" : "incremental", newWords: words };
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

export function queueStableStreamingWords(ctx: ExtensionContext, state: StreamingState, currentWords: string[], mode: StreamingFrameMode = "cumulative") {
	const words = currentWords.filter(Boolean);

	if (mode === "reset") {
		state.candidateWords = trimCommittedStreamingPrefix(state, words);
		renderStreamingPreview(ctx, state, false);
		scheduleStreamingFlush(ctx, state);
		return;
	}

	if (mode === "incremental") {
		commitStreamingCandidate(state);
		state.candidateWords = trimCommittedStreamingPrefix(state, words);
		renderStreamingPreview(ctx, state, false);
		scheduleStreamingFlush(ctx, state);
		return;
	}

	if (mode === "rolling") {
		queueRollingStreamingWords(state, words);
		renderStreamingPreview(ctx, state, false);
		scheduleStreamingFlush(ctx, state);
		return;
	}

	if (mode === "duplicate" && words.length === 0) {
		renderStreamingPreview(ctx, state, false);
		scheduleStreamingFlush(ctx, state);
		return;
	}

	const stableCount = commonStreamingPrefixLength(state.candidateWords, words);
	const confirmedCount = Math.min(stableCount, getStreamWordsPerChunk());
	if (confirmedCount > 0) queueStreamingWords(state, words.slice(0, confirmedCount));
	state.candidateWords = words.slice(confirmedCount);
	renderStreamingPreview(ctx, state, false);
	scheduleStreamingFlush(ctx, state);
}

export function flushPendingStreamingWords(ctx: ExtensionContext, state: StreamingState, trailingSpace = true) {
	clearStreamingFlush(state);
	commitStreamingCandidate(state);
	renderStreamingPreview(ctx, state, trailingSpace);
	showStreamingFrameDiagnostics(ctx, state, {
		extractionMode: "flush",
		newWords: [],
		reason: trailingSpace ? "stop flush" : "pause flush",
	});
}

export function scheduleStreamingFlush(ctx: ExtensionContext, state: StreamingState) {
	clearStreamingFlush(state);
	if (state.candidateWords.length === 0) return;
	const delayMs = getStreamFlushMs();
	state.flushTimer = setTimeout(() => {
		state.flushTimer = undefined;
		flushPendingStreamingWords(ctx, state, false);
	}, delayMs);
	unrefStreamingTimer(state.flushTimer);
}

export function queueStreamingWords(state: StreamingState, words: string[]) {
	const nextWords = words.filter(Boolean);
	if (nextWords.length === 0) return;
	const overlap = streamingWordOverlap(state.emittedWords, nextWords);
	const appendWords = nextWords.slice(overlap);
	if (appendWords.length === 0) return;
	state.emittedWords.push(...appendWords);
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

export function commonStreamingSuffixLength(previousWords: string[], currentWords: string[]) {
	const maxSuffix = Math.min(previousWords.length, currentWords.length);
	let count = 0;
	while (count < maxSuffix && normalizeStreamingWord(previousWords[previousWords.length - 1 - count] ?? "") === normalizeStreamingWord(currentWords[currentWords.length - 1 - count] ?? "")) {
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
	return state.emittedWords.join(" ");
}

export function renderStreamingPreview(ctx: ExtensionContext, state: StreamingState, trailingSpace: boolean) {
	const transcript = getStreamingTranscript(state);
	const nextText = appendTranscriptToBaseText(state.baseText, transcript, trailingSpace);
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

	const nextText = appendTranscriptToBaseText(state.baseText, transcript, true);
	ctx.ui.setEditorText(nextText);
	state.previewText = nextText;
}

export function clearStreamingFlush(state: StreamingState) {
	if (!state.flushTimer) return;
	clearTimeout(state.flushTimer);
	state.flushTimer = undefined;
}

function appendTranscriptToBaseText(baseText: string, transcript: string, trailingSpace: boolean) {
	if (!transcript) return baseText;
	const separator = needsStreamingSeparator(baseText, transcript) ? " " : "";
	const suffix = /\s$/.test(transcript) || !trailingSpace ? transcript : `${transcript} `;
	return `${baseText}${separator}${suffix}`;
}

function needsStreamingSeparator(baseText: string, transcript: string) {
	return Boolean(baseText && transcript && !/\s$/u.test(baseText) && !/^[\s.,!?;:)}\]]/u.test(transcript));
}

function queueRollingStreamingWords(state: StreamingState, words: string[]) {
	const overlap = streamingWordOverlap(state.candidateWords, words);
	if (overlap <= 0) {
		commitStreamingCandidate(state);
		state.candidateWords = trimCommittedStreamingPrefix(state, words);
		return;
	}

	const previousCandidatePrefix = state.candidateWords.slice(0, state.candidateWords.length - overlap);
	queueStreamingWords(state, previousCandidatePrefix);
	const confirmedOverlap = Math.min(overlap, getStreamWordsPerChunk());
	queueStreamingWords(state, words.slice(0, confirmedOverlap));
	state.candidateWords = trimCommittedStreamingPrefix(state, words.slice(confirmedOverlap));
}

function commitStreamingCandidate(state: StreamingState) {
	if (state.candidateWords.length === 0) return;
	queueStreamingWords(state, state.candidateWords);
	state.candidateWords = [];
}

function trimCommittedStreamingPrefix(state: StreamingState, words: string[]) {
	const overlap = streamingWordOverlap(state.emittedWords, words);
	return words.slice(overlap);
}

function isStreamingWordsPrefix(prefixWords: string[], words: string[]) {
	if (prefixWords.length === 0 || prefixWords.length > words.length) return false;
	return streamingWordsEqual(prefixWords, words.slice(0, prefixWords.length));
}

function looksLikeStreamingCorrection(previousWords: string[], currentWords: string[]) {
	if (previousWords.length === 0 || currentWords.length === 0) return false;
	if (previousWords.length === 1 && currentWords.length === 1) return false;
	if (commonStreamingPrefixLength(previousWords, currentWords) > 0) return true;
	if (commonStreamingSuffixLength(previousWords, currentWords) > 0) return true;
	const previousNormalized = new Set(previousWords.map(normalizeStreamingWord));
	const sharedCount = currentWords.filter((word) => previousNormalized.has(normalizeStreamingWord(word))).length;
	return previousWords.length > 1 && currentWords.length > 1 && sharedCount >= Math.ceil(Math.min(previousWords.length, currentWords.length) / 2);
}

function showStreamingFrameDiagnostics(ctx: ExtensionContext, state: StreamingState, details: StreamingDiagnosticDetails) {
	if (!envFlag("MICME_STREAM_DIAGNOSTICS")) return;
	const payload = {
		rawFrame: details.rawFrame === undefined ? undefined : truncateStreamingDiagnostic(stripStreamingControls(details.rawFrame)),
		sanitizedText: details.sanitizedText === undefined ? undefined : truncateStreamingDiagnostic(details.sanitizedText),
		frameWords: limitStreamingDiagnosticWords(details.frameWords ?? []),
		emittedWords: limitStreamingDiagnosticWords(state.emittedWords),
		candidateWords: limitStreamingDiagnosticWords(state.candidateWords),
		previewText: truncateStreamingDiagnostic(getStreamingTranscript(state)),
		extractionMode: details.extractionMode,
		newWords: limitStreamingDiagnosticWords(details.newWords ?? []),
		reason: details.reason,
	};
	ctx.ui.notify(`Micme stream frame: ${JSON.stringify(payload)}`, "info");
}

function limitStreamingDiagnosticWords(words: string[]) {
	return words.slice(-16);
}

function truncateStreamingDiagnostic(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function unrefStreamingTimer(timer: ReturnType<typeof setTimeout>) {
	if (typeof timer !== "object" || timer === null || !("unref" in timer)) return;
	const unref = timer.unref;
	if (typeof unref === "function") unref.call(timer);
}
