import { closeSync, fstatSync, writeFile } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { readRecordingBytes, validateCompletedClipWav, WavHeaderScanner } from "../audio-level.ts";
import { LIVE_CAPTURE_RATE as RATE } from "../constants.ts";
import { createLiveRecordingDirectory, type RecordingDirectory, type VerifiedRecordingFile } from "../recording-dir.ts";
import { bindSnapshotSource, hashRecordingBytes } from "./capture.ts";
import type { Signal, VerifiedAudio } from "./contracts.ts";

const FRAME_BYTES = 2;
const FRAME_SAMPLES = RATE / 50; // 20 ms energy windows
const SEEK_START = 27 * RATE;
const SEEK_END = 33 * RATE;
const HARD_LIMIT = 40 * RATE;
const writeFd = promisify(writeFile);

export function invalidRecognitionAudio(reason: string) {
	return new Error(`Micme requires a complete 16 kHz mono signed 16-bit PCM WAV: ${reason}.`);
}

async function readExact(file: VerifiedRecordingFile, offset: number, bytes: number, signal: Signal) {
	const result = await readRecordingBytes(file, offset, bytes, signal);
	if (result.length !== bytes) throw invalidRecognitionAudio("the audio changed during the read");
	return result;
}

/** Consume only a held private copy whose exact bytes agree with the capture receipt. */
export async function withVerifiedPcm<T>(audio: VerifiedAudio, signal: Signal, consume: (pcm: VerifiedPcm) => Promise<T>) {
	signal.throwIfAborted();
	const directory = await createLiveRecordingDirectory(process.cwd(), false, "micme-recognize-");
	let file: VerifiedRecordingFile | undefined;
	try {
		const path = await audio.copyTo(directory, signal);
		signal.throwIfAborted();
		file = directory.openVerifiedFile(path);
		if (!file) throw invalidRecognitionAudio("the verified audio copy is missing");
		const bound = bindSnapshotSource(directory, path, file);
		if (bound.bytes !== audio.bytes || await hashRecordingBytes(file, 0, bound.bytes, signal) !== audio.sha256) {
			throw invalidRecognitionAudio("the copy does not match the verified audio digest");
		}
		await validateCompletedClipWav(file, bound.bytes, signal);
		const layout = await new WavHeaderScanner("live", invalidRecognitionAudio).scan(file, bound.bytes, signal);
		if (!layout) throw invalidRecognitionAudio("the PCM header is missing");
		const result = await consume(new VerifiedPcm(file, directory, layout.dataOffset, layout.dataBytes));
		bound.check();
		signal.throwIfAborted();
		return result;
	} finally {
		try { file?.close(); await directory.remove(); }
		finally { directory.close(); }
	}
}

export class VerifiedPcm {
	private readonly file: VerifiedRecordingFile;
	readonly directory: RecordingDirectory;
	private readonly offset: number;
	readonly bytes: number;

	constructor(file: VerifiedRecordingFile, directory: RecordingDirectory, offset: number, bytes: number) {
		this.file = file;
		this.directory = directory;
		this.offset = offset;
		this.bytes = bytes;
	}

	get total() { return this.bytes / FRAME_BYTES; }

	read(from: number, samples: number, signal: Signal) {
		if (from < 0 || samples < 0 || from + samples > this.total) throw invalidRecognitionAudio("requested PCM is outside the file");
		return readExact(this.file, this.offset + from * FRAME_BYTES, samples * FRAME_BYTES, signal);
	}

	digest(signal: Signal) { return hashRecordingBytes(this.file, this.offset, this.bytes, signal); }

	async nextChunk(from: number, maxSamples: number, signal: Signal) {
		const pcm = await this.read(from, Math.min(this.total - from, maxSamples, HARD_LIMIT), signal);
		const cut = quietBoundary(pcm);
		return cut ? pcm.subarray(0, cut) : pcm;
	}

	async withChunk<T>(pcm: Buffer, signal: Signal, consume: (path: string) => Promise<T>) {
		const header = await readExact(this.file, 0, this.offset, signal);
		header.writeUInt32LE(this.offset + pcm.length - 8, 4);
		header.writeUInt32LE(pcm.length, this.offset - 4);
		const path = join(this.directory.filesPath, "chunk.wav");
		const fd = this.directory.createPrivateFile(path);
		const stamp = fstatSync(fd, { bigint: true });
		try {
			try {
				await writeFd(fd, header);
				await writeFd(fd, pcm);
			} finally { closeSync(fd); }
			signal.throwIfAborted();
			return await consume(path);
		} finally { this.directory.discardPrivateFile(path, stamp); }
	}
}

// Look for a genuine quiet interval around the target. A cut owns each sample
// exactly once; neither overlap nor textual deduplication can erase a real repeat.
function quietBoundary(pcm: Buffer) {
	if (pcm.length < SEEK_END * FRAME_BYTES) return 0;
	let quiet = 0;
	let cut = 0;
	for (let i = SEEK_START; i + FRAME_SAMPLES <= SEEK_END; i += FRAME_SAMPLES) {
		let sum = 0;
		for (let j = i; j < i + FRAME_SAMPLES; j++) sum += Math.abs(pcm.readInt16LE(j * FRAME_BYTES));
		quiet = sum / FRAME_SAMPLES <= 128 ? quiet + 1 : 0;
		if (quiet >= 8) {
			const mid = i + FRAME_SAMPLES - Math.floor(quiet * FRAME_SAMPLES / 2);
			if (!cut || Math.abs(mid - 30 * RATE) < Math.abs(cut - 30 * RATE)) cut = mid;
		}
	}
	return cut * FRAME_BYTES;
}

type DecodeChunk = (from: number, pcm: Buffer) => Promise<void>;

/** One bounded chunk of PCM, also when a recorder overproduces or a long file is interrupted. */
export class PauseChunks {
	private readonly buffer: Buffer;
	private used = 0;
	private sought = false;
	private from = 0;

	constructor(maxSamples: number) {
		this.buffer = Buffer.allocUnsafe(Math.min(maxSamples, HARD_LIMIT) * FRAME_BYTES);
	}

	async append(pcm: Buffer, decode: DecodeChunk) {
		let offset = 0;
		while (offset < pcm.length) {
			// Seek at the same sample regardless of the caller's block divisions.
			const next = this.sought ? this.buffer.length : Math.min(this.buffer.length, SEEK_END * FRAME_BYTES);
			const bytes = Math.min(next - this.used, pcm.length - offset);
			pcm.copy(this.buffer, this.used, offset, offset + bytes);
			this.used += bytes;
			offset += bytes;
			if (this.used < next) continue;
			if (!this.sought && this.used === SEEK_END * FRAME_BYTES) {
				this.sought = true;
				const cut = quietBoundary(this.buffer);
				if (cut) await this.flush(cut, decode);
			}
			if (this.used === this.buffer.length) await this.flush(this.used, decode);
		}
	}

	async finish(decode: DecodeChunk) {
		if (this.used) await this.flush(this.used, decode);
	}

	private async flush(bytes: number, decode: DecodeChunk) {
		const chunk = this.buffer.subarray(0, bytes);
		await decode(this.from, chunk);
		this.from += bytes / FRAME_BYTES;
		this.buffer.copyWithin(0, bytes, this.used);
		this.used -= bytes;
		this.sought = false;
	}
}

const compactEnd = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、：；」』）]$/u;
const compactStart = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}「『（]/u;
const attachesToPrevious = /^[,.;:!?，。！？、：；」』）]/u;

export function joinChunks(left: string, right: string) {
	if (!right || !left) return left || right;
	const adjacent = attachesToPrevious.test(right) || (compactEnd.test(left) && compactStart.test(right));
	return left + (adjacent ? "" : " ") + right;
}
