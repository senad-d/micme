import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, write, type BigIntStats } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { availableClipPcm, hasNonzeroPcm, readRecordingBytes, scanClipWav, validateCompletedClipWav } from "../audio-level.ts";
import { hasRecorderExited } from "../processes.ts";
import type { LivePcmReader } from "../live-capture.ts";
import type { RecordingDirectory, VerifiedRecordingFile } from "../recording-dir.ts";
import type { Recording } from "../types.ts";
import type { Capture, NoteLiveBlock, ObserveCapture, VerifiedAudio } from "./contracts.ts";

const CLIP_POLL_MS = 20;
const COPY_BLOCK_BYTES = 64 * 1024;
const writeAt = promisify(write);
const clipObservations = new WeakMap<Recording, Promise<void>>();

export function initialCapture(source: Capture["source"], requested: string | null = null): Capture {
	return { stage: "preparing", source, requested: source === "builtin" ? requested : null, actual: null, channel: null, fallback: null, firstSampleMs: null };
}

export const noteLiveBlock: NoteLiveBlock = (prior, pcm, elapsedMs) => {
	if (!pcm.length) return prior;
	return noteSamples(prior, hasNonzeroPcm(pcm), elapsedMs);
};

function noteSamples(prior: Capture, nonzero: boolean, elapsedMs: number): Capture {
	const stage = nonzero ? "samples" : "digital-zero";
	if (prior.stage === stage && prior.firstSampleMs !== null) return prior;
	return { ...prior, stage, firstSampleMs: prior.firstSampleMs ?? elapsedMs };
}

export const observeCapture: ObserveCapture = (recording, _mode, source, onState, signal) => {
	let observation = clipObservations.get(recording);
	if (!observation) {
		observation = watchClip(recording, source, onState, signal);
		clipObservations.set(recording, observation);
	}
	return observation;
};

function clipIsActive(recording: Recording, signal: AbortSignal) {
	return !signal.aborted && !recording.stopRequested && !recording.stopPromise && !hasRecorderExited(recording);
}

async function watchClip(recording: Recording, source: Capture["source"], onState: (state: Capture) => void, signal: AbortSignal) {
	if (signal.aborted || recording.stopRequested || recording.stopPromise) return;
	let state = initialCapture(source, recording.command.capture?.requested);
	if (hasRecorderExited(recording)) {
		onState({ ...state, stage: "device-failed" });
		return;
	}
	state = { ...state, stage: source === "custom" ? "opaque-running" : "waiting" };
	onState(state);
	// Hooks may write no file until SIGINT. Never open, meter, or await PCM from them here.
	if (source === "custom") return;

	const { directory, audioPath } = recording;
	let cursor = 0;
	let dataOffset: number | undefined;
	while (clipIsActive(recording, signal)) {
		let nonzero: boolean | undefined;
		try {
			const file = directory?.holdClipFile(audioPath);
			if (file && directory) {
				assertBound(directory, audioPath, file);
				const size = file.size();
				const layout = await scanClipWav(file, size, signal);
				if (layout) {
					if (dataOffset !== undefined && dataOffset !== layout.dataOffset) throw new Error("Micme's clip PCM offset changed during recording.");
					dataOffset = layout.dataOffset;
					const available = availableClipPcm(layout, size);
					if (available < cursor) throw new Error("Micme's clip WAV shrank after samples were observed.");
					const block = Math.max(layout.frameBytes, COPY_BLOCK_BYTES - COPY_BLOCK_BYTES % layout.frameBytes);
					const count = Math.min(available - cursor, block);
					if (count > 0) {
						const bytes = await readExact(file, dataOffset + cursor, count, signal);
						assertBound(directory, audioPath, file);
						cursor += count;
						nonzero = hasNonzeroPcm(bytes, layout.zeroByte);
					}
				}
			}
		} catch {
			if (clipIsActive(recording, signal)) onState({ ...state, stage: "device-failed" });
			return;
		}
		if (nonzero !== undefined && clipIsActive(recording, signal)) {
			const next = noteSamples(state, nonzero, Math.max(0, performance.now() - recording.startedAtMonotonic));
			if (next !== state) onState(next);
			state = next;
			// Clip observation reports onset only. Speech/no-speech comes from later validation/ASR.
			if (nonzero) return;
		}
		try {
			await delay(CLIP_POLL_MS, undefined, { signal });
		} catch {
			return; // The observation lifetime was canceled.
		}
	}
	if (!signal.aborted && !recording.stopRequested && !recording.stopPromise && hasRecorderExited(recording)) {
		onState({ ...state, stage: "device-failed" });
	}
}

/** Check the owned tree's stop, not just the wrapper's exit or a plausible header. */
export async function requireStoppedRecorder(recording: Recording, signal: AbortSignal) {
	signal.throwIfAborted();
	if (!recording.stopPromise) throw new Error("Micme has not stopped the recording process tree.");
	const exit = await recording.stopPromise;
	signal.throwIfAborted();
	if (exit.error || (exit.code === null && exit.signal === null)) throw new Error("Micme could not confirm the recorder stopped.");
}

/** If retaining the raw recording directory, supply a separate caller-owned temporary snapshot target. */
export async function freezeAudio(recording: Recording, reader: LivePcmReader | null, signal: AbortSignal, target = recording.directory): Promise<VerifiedAudio | null> {
	const { directory, audioPath } = recording;
	if (!directory || !target) return null;
	try {
		await requireStoppedRecorder(recording, signal);
		if (reader) return await reader.writeRecoveryInput(target, signal);
		await clipObservations.get(recording);
		signal.throwIfAborted();
		const file = directory.holdClipFile(audioPath);
		if (!file) return null;
		const source = bindSnapshotSource(directory, audioPath, file);
		await validateCompletedClipWav(file, source.bytes, signal);
		return await snapshotVerifiedAudio(source, target, signal);
	} catch {
		return null;
	}
}

function assertBound(directory: RecordingDirectory, path: string, file: VerifiedRecordingFile) {
	if (!directory.matchesVerifiedFile(path, file)) throw new Error("Micme's recording leaf changed before verification.");
	// Also reject ambiguous hard links; a matching open descriptor alone is insufficient.
	return file.snapshotStamp();
}

export function bindSnapshotSource(directory: RecordingDirectory, path: string, file: VerifiedRecordingFile) {
	const stamp = assertBound(directory, path, file);
	const bytes = file.size();
	return {
		file, bytes, directory,
		check: () => {
			if (assertBound(directory, path, file) !== stamp || file.size() !== bytes) throw new Error("Micme's stopped recording changed during verification.");
		},
	};
}

type SnapshotSource = ReturnType<typeof bindSnapshotSource>;
type VerifyCopy = (file: VerifiedRecordingFile, signal: AbortSignal) => Promise<void>;

/** Freeze from the held descriptor; a pathname is only opened to verify an already-private copy. */
export async function snapshotVerifiedAudio(source: SnapshotSource, target: RecordingDirectory, signal: AbortSignal, verify?: VerifyCopy): Promise<VerifiedAudio> {
	const copy = await copyAudio(source, target, signal, undefined, verify, target === source.directory);
	return Object.freeze({ bytes: source.bytes, sha256: copy.sha256, copyTo: copyFrozenAudio.bind(undefined, target, copy, signal, source.bytes) });
}

type AudioCopy = { name: string; path: string; identity: string; sha256: string };

async function copyFrozenAudio(directory: RecordingDirectory, copy: AudioCopy, lifetime: AbortSignal, bytes: number, target: RecordingDirectory, signal: AbortSignal) {
	signal = AbortSignal.any([lifetime, signal]);
	signal.throwIfAborted();
	const file = directory.openVerifiedFile(copy.name);
	if (!file) throw new Error("Micme's verified audio snapshot is no longer available.");
	try {
		const source = bindSnapshotSource(directory, copy.name, file);
		if (file.identity() !== copy.identity || source.bytes !== bytes) throw new Error("Micme's verified audio snapshot was replaced.");
		return (await copyAudio(source, target, signal, copy.sha256)).path;
	} finally {
		file.close();
	}
}

async function copyAudio(source: SnapshotSource, target: RecordingDirectory, signal: AbortSignal, expectedHash?: string, verify?: VerifyCopy, transient = false): Promise<AudioCopy> {
	const name = `verified-${randomUUID()}.wav`;
	const path = target.liveFilePath(name);
	signal.throwIfAborted();
	source.check();
	const fd = target.createPrivateFile(name);
	let entry: BigIntStats | undefined;
	let published = false;
	try {
		let sha256: string;
		try {
			entry = fstatSync(fd, { bigint: true });
			sha256 = await writeAudio(source, fd, signal);
		} finally {
			closeSync(fd);
		}
		if (expectedHash !== undefined && sha256 !== expectedHash) throw new Error("Micme's verified audio snapshot failed its digest check.");
		const candidate = target.openVerifiedFile(name);
		if (!candidate) throw new Error("Micme's private audio copy could not be verified.");
		try {
			const copied = bindSnapshotSource(target, name, candidate);
			if (!target.matchesPrivateFile(name, entry) || copied.bytes !== source.bytes || await hashRecordingBytes(candidate, 0, copied.bytes, signal) !== sha256) {
				throw new Error("Micme's private audio copy failed its length or digest check.");
			}
			await verify?.(candidate, signal);
			copied.check();
			if (!target.matchesPrivateFile(name, entry)) throw new Error("Micme's private audio copy was replaced.");
			source.check();
			signal.throwIfAborted();
			const identity = candidate.identity();
			if (transient) target.discardPrivateFileOnClose(name, entry);
			published = true;
			return { name, path, identity, sha256 };
		} finally {
			candidate.close();
		}
	} finally {
		if (!published && entry) target.discardPrivateFile(name, entry);
	}
}

async function readExact(file: VerifiedRecordingFile, offset: number, count: number, signal: AbortSignal) {
	const bytes = await readRecordingBytes(file, offset, count, signal);
	if (bytes.length !== count) throw new Error("Micme's WAV was truncated during verification.");
	return bytes;
}

export async function hashRecordingBytes(file: VerifiedRecordingFile, start: number, bytes: number, signal: AbortSignal) {
	const hash = createHash("sha256");
	for (let offset = 0; offset < bytes; offset += COPY_BLOCK_BYTES) {
		hash.update(await readExact(file, start + offset, Math.min(COPY_BLOCK_BYTES, bytes - offset), signal));
	}
	return hash.digest("hex");
}

async function writeAudio(source: SnapshotSource, fd: number, signal: AbortSignal) {
	const hash = createHash("sha256");
	for (let offset = 0; offset < source.bytes; offset += COPY_BLOCK_BYTES) {
		const bytes = await readExact(source.file, offset, Math.min(COPY_BLOCK_BYTES, source.bytes - offset), signal);
		const { bytesWritten } = await writeAt(fd, bytes, 0, bytes.length, offset);
		signal.throwIfAborted();
		if (bytesWritten !== bytes.length) throw new Error("Micme could not write the complete WAV snapshot.");
		hash.update(bytes);
	}
	return hash.digest("hex");
}
