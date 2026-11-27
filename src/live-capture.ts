import { createHash } from "node:crypto";
import { closeSync, write } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildLiveRecorderSpec, LIVE_CAPTURE_RATE } from "./audio.ts";
import { readRecordingBytes, RIFF_PLACEHOLDER, WavHeaderScanner, type WavLayout } from "./audio-level.ts";
import { getTranscribeTimeoutMs } from "./config.ts";
import { MIN_AUDIO_BYTES } from "./constants.ts";
import type { RecordingDirectory, VerifiedRecordingFile } from "./recording-dir.ts";
import { bindSnapshotSource, hashRecordingBytes, requireStoppedRecorder, snapshotVerifiedAudio } from "./transfer/capture.ts";
import type { WriteRecoveryInput } from "./transfer/contracts.ts";
import type { CommandSpec, Recording } from "./types.ts";

const SAMPLE_BYTES = 2;
const MAX_READ_BYTES = LIVE_CAPTURE_RATE * SAMPLE_BYTES;
const POLL_MS = 20;
const REFINEMENT_FILE = "refinement.wav";
const EMPTY_PCM = Buffer.alloc(0);
const writeAt = promisify(write);

export interface LivePcmReader {
	read(final: boolean): Promise<{ pcm: Buffer; availableThrough: number }>;
	writeRefinementInput(target: RecordingDirectory, acknowledgedThrough: number, signal: AbortSignal): Promise<string>;
	writeRecoveryInput: WriteRecoveryInput;
	hasRetainableCapture(): Promise<boolean>;
	close(): void;
}

export async function buildLiveRecorderCommand(audioPath: string, directory: RecordingDirectory, signal: AbortSignal): Promise<CommandSpec> {
	signal.throwIfAborted();
	return buildLiveRecorderSpec(directory.liveFilePath(audioPath), directory.filesPath, signal);
}

export async function openLivePcm(audioPath: string, directory: RecordingDirectory, signal: AbortSignal, recorder?: Recording): Promise<LivePcmReader> {
	const deadline = performance.now() + getTranscribeTimeoutMs();
	for (;;) {
		signal.throwIfAborted();
		let file: VerifiedRecordingFile | undefined;
		try {
			file = directory.openVerifiedFile(audioPath);
		} catch (error) {
			throw new Error("Micme could not verify the live recording file. Check the recording directory setup or use clip mode.", { cause: error });
		}
		if (file) return new HeldLivePcm(file, directory, audioPath, signal, recorder);
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw invalidWav("timed out waiting for the recorder to create its live WAV");
		await delay(Math.min(POLL_MS, remaining), undefined, { signal });
	}
}

function invalidWav(reason: string) {
	return new Error(`Micme live capture: ${reason}. Use clip mode or configure the recorder to write a growing 16 kHz mono signed 16-bit PCM WAV.`);
}

async function requireBytes(file: VerifiedRecordingFile, offset: number, count: number, signal: AbortSignal) {
	const bytes = await readRecordingBytes(file, offset, count, signal);
	if (bytes.length !== count) throw invalidWav("the live WAV was truncated during a read");
	return bytes;
}

function checkLiveLength(layout: WavLayout, size: number) {
	const { dataOffset, riffBytes, dataBytes } = layout;
	// Some producers start with a valid zero-sample header and patch it at
	// close, others (including FFmpeg) use sentinel sizes while growing.
	if (dataBytes === 0 && riffBytes === dataOffset - 8) return;
	if ((dataBytes !== 0 && dataBytes !== RIFF_PLACEHOLDER && size > dataOffset + dataBytes) ||
		(riffBytes !== 0 && riffBytes !== RIFF_PLACEHOLDER && size > riffBytes + 8)) throw invalidWav("bytes extend beyond the declared WAV data");
}

function checkFinalLength(layout: WavLayout, size: number) {
	if (layout.riffBytes !== size - 8 || layout.dataBytes !== size - layout.dataOffset || layout.dataBytes % SAMPLE_BYTES !== 0) {
		throw invalidWav("final WAV length does not match the complete PCM payload");
	}
}

function sameLayout(layout: WavLayout | undefined, expected: WavLayout) {
	return layout?.dataOffset === expected.dataOffset && layout.riffBytes === expected.riffBytes && layout.dataBytes === expected.dataBytes;
}

function canonicalHeader(dataBytes: number) {
	if (dataBytes > RIFF_PLACEHOLDER - 36) throw invalidWav("the PCM snapshot is too large for RIFF/WAVE");
	const header = Buffer.alloc(44);
	header.write("RIFF");
	header.writeUInt32LE(36 + dataBytes, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(LIVE_CAPTURE_RATE, 24);
	header.writeUInt32LE(LIVE_CAPTURE_RATE * SAMPLE_BYTES, 28);
	header.writeUInt16LE(SAMPLE_BYTES, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataBytes, 40);
	return header;
}

async function writeBytes(fd: number, bytes: Buffer, offset: number, signal: AbortSignal) {
	signal.throwIfAborted();
	const { bytesWritten } = await writeAt(fd, bytes, 0, bytes.length, offset);
	signal.throwIfAborted();
	if (bytesWritten !== bytes.length) throw new Error("Micme could not write the complete PCM refinement snapshot.");
}

class HeldLivePcm implements LivePcmReader {
	private readonly scanner = new WavHeaderScanner("live", invalidWav);
	private readonly emitted = createHash("sha256");
	private readonly closeController = new AbortController();
	private layout?: WavLayout;
	private finalLayout?: WavLayout;
	private finalThrough?: number;
	private largestSize = 0;
	private cursorBytes = 0;
	private busy = false;

	private readonly file: VerifiedRecordingFile;
	private readonly source: RecordingDirectory;
	private readonly audioPath: string;
	private readonly signal: AbortSignal;
	private readonly recorder?: Recording;

	constructor(file: VerifiedRecordingFile, source: RecordingDirectory, audioPath: string, signal: AbortSignal, recorder?: Recording) {
		this.file = file;
		this.source = source;
		this.audioPath = audioPath;
		this.signal = AbortSignal.any([signal, this.closeController.signal]);
		this.recorder = recorder;
	}

	async read(final: boolean) {
		this.begin(this.signal);
		try {
			return await this.readPcm(final);
		} finally {
			this.end();
		}
	}

	private async readPcm(final: boolean) {
		if (!final && this.finalLayout) throw new Error("Micme already started the final PCM drain.");
		const size = this.size();
		const layout = await this.getLayout(final, size);
		this.signal.throwIfAborted();
		if (!layout) return { pcm: EMPTY_PCM, availableThrough: 0 };
		if (final) checkFinalLength(layout, size);
		else checkLiveLength(layout, size);

		const availableThrough = Math.floor((size - layout.dataOffset) / SAMPLE_BYTES);
		const count = Math.min(MAX_READ_BYTES, availableThrough * SAMPLE_BYTES - this.cursorBytes);
		if (count === 0) {
			if (final) this.finalThrough = availableThrough;
			return { pcm: EMPTY_PCM, availableThrough };
		}
		const pcm = await requireBytes(this.file, layout.dataOffset + this.cursorBytes, count, this.signal);
		this.signal.throwIfAborted();
		this.emitted.update(pcm);
		this.cursorBytes += count;
		return { pcm, availableThrough };
	}

	private async getLayout(final: boolean, size: number) {
		if (final) {
			this.finalLayout ??= await this.verifyFinalLayout(size, this.signal);
			return this.finalLayout;
		}
		this.layout ??= await this.scanner.scan(this.file, size, this.signal);
		return this.layout;
	}

	private async verifyFinalLayout(size: number, signal: AbortSignal) {
		const layout = await new WavHeaderScanner("live", invalidWav).scan(this.file, size, signal);
		if (!layout) throw invalidWav("incomplete WAV header at the end of recording");
		const prior = this.finalLayout ?? this.layout;
		if (prior && prior.dataOffset !== layout.dataOffset) throw invalidWav("the WAV data offset changed during recording");
		checkFinalLength(layout, size);
		return layout;
	}

	async hasRetainableCapture() {
		const dataOffset = this.finalLayout?.dataOffset ?? this.layout?.dataOffset ?? 0;
		if (this.finalThrough === 0 || this.file.size() < Math.max(MIN_AUDIO_BYTES, dataOffset + SAMPLE_BYTES)) return false;
		// Retention consults the still-held identity, not whatever now occupies raw.wav.
		return this.source.containsVerifiedFile(this.file);
	}

	async writeRecoveryInput(target: RecordingDirectory, signal: AbortSignal) {
		const combinedSignal = AbortSignal.any([signal, this.signal]);
		if (combinedSignal.aborted || this.busy) return null;
		this.begin(combinedSignal);
		try {
			// A plausible finalized header alone cannot prove the recorder tree stopped.
			if (!this.recorder) return null;
			await requireStoppedRecorder(this.recorder, combinedSignal);
			return await this.recover(target, combinedSignal);
		} catch {
			return null;
		} finally {
			this.end();
		}
	}

	private async recover(target: RecordingDirectory, signal: AbortSignal) {
		const source = bindSnapshotSource(this.source, this.audioPath, this.file);
		const layout = await this.verifyFinalLayout(this.size(), signal);
		const prefixBytes = this.cursorBytes;
		if (layout.dataBytes === 0 || prefixBytes > layout.dataBytes) return null;
		const prefixHash = this.emitted.copy().digest("hex");
		const drain = this.emitted.copy();
		// Read only the unread tail into a local ledger. Do not advance the normal
		// feed cursor or make ACK-gated refinement eligible for the recovered samples.
		for (let offset = prefixBytes; offset < layout.dataBytes; offset += MAX_READ_BYTES) {
			const count = Math.min(MAX_READ_BYTES, layout.dataBytes - offset);
			drain.update(await requireBytes(this.file, layout.dataOffset + offset, count, signal));
		}
		const finalHash = drain.digest("hex");
		return snapshotVerifiedAudio(source, target, signal, this.verifyRecoveredWav.bind(this, layout, source.bytes, prefixBytes, prefixHash, finalHash));
	}

	private async verifyRecoveredWav(layout: WavLayout, bytes: number, prefixBytes: number, prefixHash: string, finalHash: string, copy: VerifiedRecordingFile, signal: AbortSignal) {
		const copiedLayout = await new WavHeaderScanner("live", invalidWav).scan(copy, bytes, signal);
		if (!sameLayout(copiedLayout, layout)) throw invalidWav("the recovery WAV layout changed");
		const copiedPrefix = await hashRecordingBytes(copy, layout.dataOffset, prefixBytes, signal);
		if (copiedPrefix !== prefixHash) throw invalidWav("the read PCM prefix changed before recovery");
		const copiedPayload = await hashRecordingBytes(copy, layout.dataOffset, layout.dataBytes, signal);
		if (copiedPayload !== finalHash) throw invalidWav("the recovery PCM digest does not match the held capture");
		const finalLayout = await this.verifyFinalLayout(this.size(), signal);
		if (!sameLayout(finalLayout, layout)) throw invalidWav("the stopped WAV layout changed during recovery");
	}

	async writeRefinementInput(target: RecordingDirectory, acknowledgedThrough: number, signal: AbortSignal) {
		const combinedSignal = AbortSignal.any([signal, this.signal]);
		this.begin(combinedSignal);
		try {
			if (this.finalThrough === undefined || acknowledgedThrough !== this.finalThrough) throw new Error("Micme can only copy fully drained PCM matching the acknowledged sample count.");
			if (target === this.source) throw new Error("Micme requires a separate private directory for PCM refinement.");
			return await this.copyRefinementInput(target, acknowledgedThrough * SAMPLE_BYTES, combinedSignal);
		} finally {
			this.end();
		}
	}

	private async copyRefinementInput(target: RecordingDirectory, dataBytes: number, signal: AbortSignal) {
		const size = this.size();
		const layout = await this.verifySnapshotSource(size, dataBytes, signal);
		const header = canonicalHeader(dataBytes);
		const path = target.liveFilePath(REFINEMENT_FILE);
		const fd = target.createPrivateFile(REFINEMENT_FILE);
		try {
			await writeBytes(fd, header, 0, signal);
			const copied = createHash("sha256");
			for (let offset = 0; offset < dataBytes; offset += MAX_READ_BYTES) {
				const pcm = await requireBytes(this.file, layout.dataOffset + offset, Math.min(MAX_READ_BYTES, dataBytes - offset), signal);
				signal.throwIfAborted();
				copied.update(pcm);
				await writeBytes(fd, pcm, header.length + offset, signal);
			}
			if (!copied.digest().equals(this.emitted.copy().digest())) throw invalidWav("the PCM payload changed after being read for live transcription (digest mismatch)");
			await this.verifySnapshotSource(this.size(), dataBytes, signal);
			return path;
		} finally {
			// The caller owns the fresh snapshot directory and removes it even on error.
			closeSync(fd);
		}
	}

	private async verifySnapshotSource(size: number, dataBytes: number, signal: AbortSignal) {
		const layout = await this.verifyFinalLayout(size, signal);
		signal.throwIfAborted();
		if (layout.dataOffset !== this.finalLayout?.dataOffset || layout.dataBytes !== dataBytes) throw invalidWav("the WAV layout or sample count changed after final drain");
		return layout;
	}

	private size() {
		const size = this.file.size();
		if (!Number.isSafeInteger(size) || size > RIFF_PLACEHOLDER + 8) throw invalidWav("the live WAV exceeds the supported RIFF size");
		if (size < this.largestSize) throw invalidWav("the live WAV was truncated");
		this.largestSize = size;
		return size;
	}

	private begin(signal: AbortSignal) {
		signal.throwIfAborted();
		if (this.busy) throw new Error("Micme's live PCM reader already has a pending operation.");
		this.busy = true;
	}

	private end() {
		this.busy = false;
		if (this.closeController.signal.aborted) this.file.close();
	}

	close() {
		if (this.closeController.signal.aborted) return;
		this.closeController.abort(new Error("Micme's live PCM reader is closed."));
		if (!this.busy) this.file.close();
	}
}
