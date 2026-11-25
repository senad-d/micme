import { createHash } from "node:crypto";
import { closeSync, write } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildLiveRecorderSpec, LIVE_CAPTURE_RATE } from "./audio.ts";
import { getTranscribeTimeoutMs } from "./config.ts";
import type { RecordingDirectory, VerifiedRecordingFile } from "./recording-dir.ts";
import type { CommandSpec } from "./types.ts";

const SAMPLE_BYTES = 2;
const MAX_READ_BYTES = 16_000 * SAMPLE_BYTES;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_HEADER_CHUNKS = 256;
const RIFF_PLACEHOLDER = 0xffffffff;
const POLL_MS = 20;
const REFINEMENT_FILE = "refinement.wav";
const PCM_SUBFORMAT = Buffer.from("0100000000001000800000aa00389b71", "hex");
const EMPTY_PCM = Buffer.alloc(0);
const writeAt = promisify(write);

export interface LivePcmReader {
	read(final: boolean): Promise<{ pcm: Buffer; availableThrough: number }>;
	writeRefinementInput(target: RecordingDirectory, acknowledgedThrough: number, signal: AbortSignal): Promise<string>;
	close(): void;
}

export async function buildLiveRecorderCommand(audioPath: string, directory: RecordingDirectory, signal: AbortSignal): Promise<CommandSpec> {
	signal.throwIfAborted();
	return buildLiveRecorderSpec(directory.liveFilePath(audioPath), directory.filesPath, signal);
}

export async function openLivePcm(audioPath: string, directory: RecordingDirectory, signal: AbortSignal): Promise<LivePcmReader> {
	const deadline = performance.now() + getTranscribeTimeoutMs();
	for (;;) {
		signal.throwIfAborted();
		let file: VerifiedRecordingFile | undefined;
		try {
			file = directory.openVerifiedFile(audioPath);
		} catch (error) {
			throw new Error("Micme could not verify the live recording file. Check the recording directory setup or use clip mode.", { cause: error });
		}
		if (file) return new HeldLivePcm(file, directory, signal);
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw invalidWav("timed out waiting for the recorder to create its live WAV");
		await delay(Math.min(POLL_MS, remaining), undefined, { signal });
	}
}

function invalidWav(reason: string) {
	return new Error(`Micme live capture: ${reason}. Use clip mode or configure the recorder to write a growing 16 kHz mono signed 16-bit PCM WAV.`);
}

async function requireBytes(file: VerifiedRecordingFile, offset: number, count: number, signal: AbortSignal) {
	signal.throwIfAborted();
	const bytes = Buffer.allocUnsafe(count);
	const actual = await file.readAt(bytes, offset);
	signal.throwIfAborted();
	if (actual !== count) throw invalidWav("the live WAV was truncated during a read");
	return bytes;
}

type WavLayout = { dataOffset: number; riffBytes: number; dataBytes: number };

class WavHeaderScanner {
	private riffBytes?: number;
	private offset = 12;
	private chunks = 0;
	private hasFormat = false;

	async scan(file: VerifiedRecordingFile, size: number, signal: AbortSignal): Promise<WavLayout | undefined> {
		if (this.riffBytes === undefined) {
			if (size < 12) return undefined;
			const riff = await requireBytes(file, 0, 12, signal);
			if (riff.toString("latin1", 0, 4) !== "RIFF" || riff.toString("latin1", 8) !== "WAVE") throw invalidWav("expected RIFF/WAVE (not RF64 or big-endian WAV)");
			this.riffBytes = riff.readUInt32LE(4);
		}
		while (this.offset + 8 <= size) {
			const start = this.offset + 8;
			if (start > MAX_HEADER_BYTES || this.chunks >= MAX_HEADER_CHUNKS) throw invalidWav("the WAV metadata exceeds the live header limit");
			const chunk = await requireBytes(file, this.offset, 8, signal);
			const id = chunk.toString("latin1", 0, 4);
			const length = chunk.readUInt32LE(4);
			if (id === "data") {
				if (!this.hasFormat) throw invalidWav("missing format chunk before PCM data");
				if (length !== RIFF_PLACEHOLDER && length % SAMPLE_BYTES) throw invalidWav("the declared PCM length ends with an incomplete sample");
				return { dataOffset: start, riffBytes: this.riffBytes, dataBytes: length };
			}
			const next = start + length + (length % 2);
			if (next + 8 > MAX_HEADER_BYTES) throw invalidWav("the WAV metadata exceeds the live header limit");
			if (next > size) return undefined;
			if (id === "fmt ") {
				if (this.hasFormat) throw invalidWav("duplicate WAV format chunk");
				if (length < 16 || length === 17 || !isPcmFormat(await requireBytes(file, start, Math.min(length, 40), signal), length)) {
					throw invalidWav("expected 16 kHz mono signed 16-bit PCM");
				}
				this.hasFormat = true;
			}
			this.offset = next;
			this.chunks++;
		}
		return undefined;
	}
}

function isPcmFormat(fmt: Buffer, length: number) {
	if (fmt.readUInt16LE(2) !== 1 || fmt.readUInt32LE(4) !== LIVE_CAPTURE_RATE || fmt.readUInt32LE(8) !== LIVE_CAPTURE_RATE * SAMPLE_BYTES ||
		fmt.readUInt16LE(12) !== SAMPLE_BYTES || fmt.readUInt16LE(14) !== 16) return false;
	const extensionBytes = length > 16 ? fmt.readUInt16LE(16) : 0;
	if (extensionBytes > length - 18 && length > 16) return false;
	const tag = fmt.readUInt16LE(0);
	return tag === 1 || (tag === 0xfffe && extensionBytes >= 22 && fmt.readUInt16LE(18) === 16 && fmt.subarray(24, 40).equals(PCM_SUBFORMAT));
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
	private readonly scanner = new WavHeaderScanner();
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
	private readonly signal: AbortSignal;

	constructor(file: VerifiedRecordingFile, source: RecordingDirectory, signal: AbortSignal) {
		this.file = file;
		this.source = source;
		this.signal = AbortSignal.any([signal, this.closeController.signal]);
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
		const layout = await new WavHeaderScanner().scan(this.file, size, signal);
		if (!layout) throw invalidWav("incomplete WAV header at the end of recording");
		if (this.layout && this.layout.dataOffset !== layout.dataOffset) throw invalidWav("the WAV data offset changed during recording");
		checkFinalLength(layout, size);
		return layout;
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
