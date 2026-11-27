import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { getMeterFloorDb, getMeterGain, getMeterPeakFloorDb, getMeterRangeDb } from "./config.ts";
import { LIVE_CAPTURE_RATE } from "./constants.ts";
import type { VerifiedRecordingFile } from "./recording-dir.ts";

const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_WAV_CHUNKS = 256;
const PCM_SUBFORMAT = Buffer.from("0100000000001000800000aa00389b71", "hex");
export const RIFF_PLACEHOLDER = 0xffffffff;

export function hasNonzeroPcm(pcm: Buffer, zeroByte = 0) {
	return pcm.some((byte) => byte !== zeroByte);
}

export async function readRecordingBytes(file: VerifiedRecordingFile, offset: number, count: number, signal: AbortSignal) {
	signal.throwIfAborted();
	const bytes = Buffer.allocUnsafe(count);
	const actual = await file.readAt(bytes, offset);
	signal.throwIfAborted();
	return bytes.subarray(0, actual);
}

type WavReadError = (reason: string) => Error;
export type WavLayout = { dataOffset: number; riffBytes: number; dataBytes: number; frameBytes: number; zeroByte: number };

export class WavHeaderScanner {
	private riffBytes?: number;
	private offset = 12;
	private chunks = 0;
	private format?: Pick<WavLayout, "frameBytes" | "zeroByte">;
	private readonly mode: "clip" | "live";
	private readonly invalid: WavReadError;

	constructor(mode: "clip" | "live", invalid: WavReadError) {
		this.mode = mode;
		this.invalid = invalid;
	}

	async scan(file: VerifiedRecordingFile, size: number, signal: AbortSignal): Promise<WavLayout | undefined> {
		if (this.riffBytes === undefined) {
			if (size < 12) return undefined;
			const riff = await this.requireBytes(file, 0, 12, signal);
			if (riff.toString("latin1", 0, 4) !== "RIFF" || riff.toString("latin1", 8, 12) !== "WAVE") throw this.invalid("expected RIFF/WAVE (not RF64 or big-endian WAV)");
			this.riffBytes = riff.readUInt32LE(4);
		}
		while (this.offset + 8 <= size) {
			const start = this.offset + 8;
			if (start > MAX_HEADER_BYTES || this.chunks >= MAX_WAV_CHUNKS) throw this.metadataLimit();
			const chunk = await this.requireBytes(file, this.offset, 8, signal);
			const id = chunk.toString("latin1", 0, 4);
			const length = chunk.readUInt32LE(4);
			if (id === "data") {
				if (!this.format) throw this.invalid("missing format chunk before PCM data");
				if (length !== RIFF_PLACEHOLDER && length % this.format.frameBytes) throw this.invalid("the declared PCM length ends with an incomplete sample");
				return { dataOffset: start, riffBytes: this.riffBytes, dataBytes: length, ...this.format };
			}
			const next = start + paddedLength(length);
			if (next + 8 > MAX_HEADER_BYTES) throw this.metadataLimit();
			if (next > size) return undefined;
			if (id === "fmt ") {
				if (this.format) throw this.invalid("duplicate WAV format chunk");
				const fmt = await this.requireBytes(file, start, Math.min(length, 40), signal);
				this.format = parsePcmFormat(fmt, length, this.mode);
				if (!this.format) throw this.invalid(this.mode === "live" ? "expected 16 kHz mono signed 16-bit PCM" : "expected uncompressed integer PCM with a valid WAV format chunk");
			}
			this.offset = next;
			this.chunks++;
		}
		return undefined;
	}

	private metadataLimit() {
		return this.invalid(`the WAV metadata exceeds the ${this.mode} header limit`);
	}

	private async requireBytes(file: VerifiedRecordingFile, offset: number, count: number, signal: AbortSignal) {
		const bytes = await readRecordingBytes(file, offset, count, signal);
		if (bytes.length !== count) throw this.invalid("the WAV was truncated during a read");
		return bytes;
	}
}

function parsePcmFormat(fmt: Buffer, length: number, mode: "clip" | "live") {
	if (length < 16 || length === 17) return undefined;
	const tag = fmt.readUInt16LE(0);
	const channels = fmt.readUInt16LE(2);
	const rate = fmt.readUInt32LE(4);
	const frameBytes = fmt.readUInt16LE(12);
	const bits = fmt.readUInt16LE(14);
	if (![8, 16, 24, 32].includes(bits) || channels === 0 || rate === 0 || frameBytes !== channels * bits / 8 || fmt.readUInt32LE(8) !== rate * frameBytes) return undefined;
	if (mode === "live" && (channels !== 1 || rate !== LIVE_CAPTURE_RATE || bits !== 16)) return undefined;
	const extensionBytes = length > 16 ? fmt.readUInt16LE(16) : 0;
	if (length > 16 && extensionBytes > length - 18) return undefined;
	if (tag !== 1) {
		if (tag !== 0xfffe || extensionBytes < 22 || !fmt.subarray(24, 40).equals(PCM_SUBFORMAT)) return undefined;
		const validBits = fmt.readUInt16LE(18);
		if (validBits === 0 || validBits > bits || (mode === "live" && validBits !== bits)) return undefined;
	}
	return { frameBytes, zeroByte: bits === 8 ? 128 : 0 };
}

function paddedLength(bytes: number) {
	return bytes + bytes % 2;
}

function invalidClipWav(reason: string) {
	return new Error(`Micme clip capture: ${reason}.`);
}

export function scanClipWav(file: VerifiedRecordingFile, size: number, signal: AbortSignal) {
	return new WavHeaderScanner("clip", invalidClipWav).scan(file, size, signal);
}

export function availableClipPcm(layout: WavLayout, size: number) {
	const { dataOffset, riffBytes, dataBytes, frameBytes } = layout;
	const provisionalRiff = riffBytes === RIFF_PLACEHOLDER || riffBytes === 0;
	if (!provisionalRiff && dataBytes === RIFF_PLACEHOLDER) return 0; // Header is being patched at close.
	if (!provisionalRiff && dataOffset + paddedLength(dataBytes) > riffBytes + 8) throw invalidClipWav("PCM data extends beyond the declared RIFF length");
	const available = size - dataOffset;
	// With provisional sizes an odd trailing byte could be padding, not an 8-bit sample.
	const bytes = dataBytes === RIFF_PLACEHOLDER ? available - available % 2 : Math.min(available, dataBytes);
	return bytes - bytes % frameBytes;
}

export async function validateCompletedClipWav(file: VerifiedRecordingFile, size: number, signal: AbortSignal) {
	const layout = await scanClipWav(file, size, signal);
	if (!layout || layout.riffBytes !== size - 8 || layout.dataBytes === 0 || layout.dataBytes === RIFF_PLACEHOLDER) throw invalidClipWav("expected a complete, nonempty PCM WAV");
	let offset = layout.dataOffset + paddedLength(layout.dataBytes);
	for (let chunks = 0; offset < size; chunks++) {
		if (chunks >= MAX_WAV_CHUNKS || offset + 8 > size) throw invalidClipWav("invalid trailing WAV chunks");
		const chunk = await readRecordingBytes(file, offset, 8, signal);
		if (chunk.length !== 8 || ["data", "fmt "].includes(chunk.toString("latin1", 0, 4))) throw invalidClipWav("invalid trailing WAV chunk");
		offset += 8 + paddedLength(chunk.readUInt32LE(4));
	}
	if (offset !== size) throw invalidClipWav("the final WAV length does not match the complete PCM and chunks");
}

export function readPcm16WaveLevel(path: string, openFile: (path: string, flags: number) => number = openSync) {
	try {
		const fd = openFile(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		try {
			const stats = fstatSync(fd);
			if (!stats.isFile() || stats.size <= 45) return 0;
			const start = Math.max(44, stats.size - 48_000);
			const length = stats.size - start;
			const buffer = Buffer.alloc(length - (length % 2));
			readSync(fd, buffer, 0, buffer.length, start);
			return pcm16BufferLevel(buffer);
		} finally {
			closeSync(fd);
		}
	} catch {
		return 0;
	}
}

export function pcm16BufferLevel(buffer: Buffer) {
	let sumSquares = 0;
	let peak = 0;
	const samples = Math.floor(buffer.length / 2);
	if (samples <= 0) return 0;

	for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
		const sample = buffer.readInt16LE(offset) / 32768;
		const abs = Math.abs(sample);
		if (abs > peak) peak = abs;
		sumSquares += sample * sample;
	}

	const rms = Math.sqrt(sumSquares / samples);
	if (!Number.isFinite(rms) || rms <= 0) return 0;

	const rmsDb = 20 * Math.log10(rms);
	const peakDb = peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
	const rmsLevel = (rmsDb + getMeterFloorDb()) / getMeterRangeDb();
	const peakLevel = (peakDb + getMeterPeakFloorDb()) / getMeterRangeDb();
	const level = Math.max(rmsLevel, peakLevel * 0.8) * getMeterGain();
	return Math.max(0, Math.min(1, level));
}

