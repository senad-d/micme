import { closeSync, constants, fstatSync, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { validateCompletedClipWav, WavHeaderScanner } from "../audio-level.ts";
import { getTransferOptions } from "../config.ts";
import { LIVE_CAPTURE_RATE } from "../constants.ts";
import { posixFileIdentity } from "../posix-directory.ts";
import { findExecutable, runProcess } from "../processes.ts";
import { createLiveRecordingDirectory, type RecordingDirectory } from "../recording-dir.ts";
import { sanitizeTerminalText } from "../terminal-text.ts";
import { bindSnapshotSource, snapshotVerifiedAudio } from "./capture.ts";
import type { CancelJob, Choice, EntryId, File, ImportFiles, RecognizeFile, Row, Signal, VerifiedAudio } from "./contracts.ts";
import { enqueueImport, publishAudio, updateTake, verifiedAudio } from "./library.ts";
import { recognizeFile } from "./recognition.ts";

// Allow self-contained media containers, not playlists, manifests, devices or scripts.
// The only enabled input protocol can read the inherited descriptor, not a filename or URL.
const MEDIA_INPUT = ["-protocol_whitelist", "fd", "-format_whitelist", "wav,mp3,aac,flac,ogg,aiff,mov,matroska,webm,avi,mpegts"];
const PROBE_TIMEOUT_MS = 60_000;
const DECODE_TIMEOUT_MS = 30 * 60_000;
const MAX_RECENT_ERRORS = 64;
const OUTPUT = "normalized.wav";
const CLEANUP_SIGNAL = new AbortController().signal;
const NO_LOCAL_MEDIA = "Micme import requires a readable, regular local file selected by absolute path. Reselect the source to try again.";

type MediaSource = { path: string; stamp: string };
type ImportJob = {
	id: EntryId; source: MediaSource | Error; choice: Choice; controller: AbortController; signal: Signal; onAbort: () => void;
};

function requireHistory() {
	if (!getTransferOptions().MICME_HISTORY) throw new Error("Micme local history must be enabled before importing media.");
}

function mediaStamp(stat: BigIntStats) {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function selectMedia(path: string): Promise<MediaSource | Error> {
	if (!isAbsolute(path) || path.includes("\0")) return new Error(NO_LOCAL_MEDIA);
	const entry = await lstat(path, { bigint: true }).catch(() => undefined);
	return entry?.isFile() ? { path, stamp: mediaStamp(entry) } : new Error(NO_LOCAL_MEDIA);
}

function checkMedia(source: MediaSource, stat: BigIntStats) {
	if (!stat.isFile() || source.stamp !== mediaStamp(stat)) {
		throw new Error("The selected media changed before or during import. Reselect the source to try again.");
	}
}

async function runMediaTool(tool: string, command: string, args: string[], timeout: number, source: MediaSource, signal: Signal, stdout?: number) {
	signal.throwIfAborted();
	const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		.catch(() => { throw new Error(NO_LOCAL_MEDIA); });
	try {
		checkMedia(source, await file.stat({ bigint: true }));
		const result = await runProcess(resolve(command), args, timeout, { signal, fileStdio: { stdin: file.fd, stdout } });
		signal.throwIfAborted();
		checkMedia(source, await file.stat({ bigint: true }));
		if (result.timedOut) throw new Error(`Micme import timed out waiting for ${tool}.`);
		if (result.code !== 0 || result.stdoutTruncated || result.stderr.trim()) {
			const detail = sanitizeTerminalText(result.stderr.replace(/\p{Bidi_Control}/gu, "")).slice(0, 420);
			const hint = /protocol not found/i.test(detail) ? " Install FFmpeg and ffprobe with seekable fd: protocol support." : "";
			throw new Error(`${tool} could not read the selected media${detail ? `: ${detail}` : "."}${hint}`);
		}
		return result.stdout;
	} finally { await file.close(); }
}

async function firstAudioStream(command: string, source: MediaSource, signal: Signal) {
	const output = await runMediaTool("ffprobe", command, ["-v", "error", ...MEDIA_INPUT,
		"-select_streams", "a:0", "-show_entries", "stream=index", "-of", "json", "fd:"], PROBE_TIMEOUT_MS, source, signal);
	const { streams } = JSON.parse(output) as { streams?: { index: unknown }[] };
	if (streams?.length === 0) throw new Error("The selected media contains no audio track.");
	const index = streams?.[0]?.index;
	if (streams?.length !== 1 || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
		throw new Error("ffprobe did not identify a single first audio track.");
	}
	return index;
}

async function normalizeMedia(directory: RecordingDirectory, command: string, source: MediaSource, index: number, signal: Signal) {
	const fd = directory.createPrivateFile(OUTPUT);
	try {
		const identity = posixFileIdentity(fstatSync(fd, { bigint: true }));
		await runMediaTool("FFmpeg", command, ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-filter_threads", "1", "-threads", "1",
			...MEDIA_INPUT, "-err_detect", "explode", "-i", "fd:", "-map", `0:${index}`, "-map_metadata", "-1", "-map_chapters", "-1",
			"-ac", "1", "-ar", String(LIVE_CAPTURE_RATE), "-c:a", "pcm_s16le", "-fflags", "+bitexact", "-f", "wav", "-rf64", "never", "fd:"],
		DECODE_TIMEOUT_MS, source, signal, fd);
		return await verifyOutput(directory, identity, signal);
	} finally { closeSync(fd); }
}

async function verifyOutput(directory: RecordingDirectory, identity: string, signal: Signal) {
	const file = directory.openVerifiedFile(OUTPUT);
	if (!file) throw new Error("Micme could not open the normalized WAV for verification.");
	try {
		if (file.identity() !== identity) throw new Error("Micme's normalized WAV was replaced before verification.");
		const bound = bindSnapshotSource(directory, OUTPUT, file);
		await validateCompletedClipWav(file, bound.bytes, signal);
		const invalid = () => new Error("FFmpeg did not produce a complete mono 16 kHz PCM16 WAV.");
		const layout = await new WavHeaderScanner("live", invalid).scan(file, bound.bytes, signal);
		if (!layout) throw invalid();
		const audio = await snapshotVerifiedAudio(bound, directory, signal);
		return { audio, total: layout.dataBytes / layout.frameBytes };
	} finally { file.close(); }
}

class ImportStorageError extends Error {
	constructor(cause?: unknown) { super("Micme could not save this import in the local history library.", { cause }); }
}

async function storeResult<T>(work: Promise<T>) {
	try { return await work; }
	catch (error) { throw new ImportStorageError(error); }
}

async function decodeImport(job: ImportJob) {
	const { source, signal } = job;
	if (source instanceof Error) throw source;
	const probe = findExecutable(["ffprobe"]);
	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!probe || !ffmpeg) throw new Error("Micme import requires installed FFmpeg and ffprobe.");
	const index = await firstAudioStream(probe, source, signal);
	signal.throwIfAborted();
	const directory = await createLiveRecordingDirectory(process.cwd(), false, "micme-import-");
	try {
		const { audio, total } = await normalizeMedia(directory, ffmpeg, source, index, signal);
		await storeResult(publishAudio(job.id, audio, signal));
		return total;
	} finally {
		try { await directory.remove(); } catch { /* Do not delete an unverifiable replacement or relabel committed audio. */ }
		finally { directory.close(); }
	}
}

/** FIFO normalization and submission; the shared recognizer arbitrates each inference chunk. */
export class MediaImportService {
	private readonly recognize: RecognizeFile;
	private readonly jobs = new Map<EntryId, ImportJob>();
	private readonly errors = new Map<EntryId, string>();
	private active?: ImportJob;

	constructor(recognize: RecognizeFile = recognizeFile) { this.recognize = recognize; }

	async importFiles(paths: readonly File[], choice: Choice, signal: Signal) {
		signal.throwIfAborted();
		requireHistory();
		const selected = Object.freeze({ ...choice });
		const ids: EntryId[] = [];
		for (const path of [...paths]) {
			signal.throwIfAborted();
			const source = await selectMedia(path);
			const id = await enqueueImport(basename(path) || "Invalid media path", selected, signal);
			const controller = new AbortController();
			const jobSignal = AbortSignal.any([signal, controller.signal]);
			const onAbort = () => {
				if (this.active !== job && this.jobs.delete(id)) void this.fail(job, jobSignal.reason);
			};
			const job = { id, source, choice: selected, controller, signal: jobSignal, onAbort };
			this.jobs.set(id, job);
			jobSignal.addEventListener("abort", onAbort, { once: true });
			if (jobSignal.aborted) onAbort();
			ids.push(id);
			this.runNext();
		}
		return ids;
	}

	cancelJob(id: EntryId) { this.jobs.get(id)?.controller.abort(); }
	getImportError(id: EntryId) { return this.errors.get(id) ?? null; }

	private runNext() {
		if (this.active) return;
		const job = this.jobs.values().next().value;
		if (!job) return;
		this.active = job;
		void this.run(job).finally(() => {
			job.signal.removeEventListener("abort", job.onAbort);
			this.jobs.delete(job.id);
			this.active = undefined;
			this.runNext();
		});
	}

	private async run(job: ImportJob) {
		const { id, signal } = job;
		try {
			signal.throwIfAborted();
			requireHistory();
			await storeResult(updateTake(id, { state: "decoding" }, signal));
			const total = await decodeImport(job);
			const audio = await storeResult(verifiedAudio(id, signal));
			if (!audio) throw new ImportStorageError();
			await storeResult(updateTake(id, { state: "recognizing", totalSamples: total }, signal));
			await this.transcribe(job, audio, total);
		} catch (error) { await this.fail(job, error); }
	}

	private async transcribe(job: ImportJob, audio: VerifiedAudio, samples: number) {
		const { id, choice, signal } = job;
		const progressFailure = new AbortController();
		const inferenceSignal = AbortSignal.any([signal, progressFailure.signal]);
		let progress = Promise.resolve();
		const onProgress = (doneSamples: number, totalSamples: number) => {
			progress = progress.then(async () => {
				if (!inferenceSignal.aborted) await storeResult(updateTake(id, { doneSamples, totalSamples }, signal));
			}).catch((error: unknown) => progressFailure.abort(error));
		};
		let final: Awaited<ReturnType<RecognizeFile>>;
		try { final = await this.recognize(audio, choice, "import", onProgress, inferenceSignal); }
		finally {
			await progress;
			if (!signal.aborted) progressFailure.signal.throwIfAborted();
		}
		signal.throwIfAborted();
		if (!final.raw.trim()) throw new Error("Micme import produced no transcript. The verified audio was kept for retry.");
		await storeResult(updateTake(id, { state: "ready", raw: final.raw, local: final.local, language: final.language ?? undefined,
			doneSamples: samples, totalSamples: samples }, signal));
	}

	private async fail(job: ImportJob, error: unknown) {
		const state: Row["state"] = job.signal.aborted ? "canceled" : error instanceof ImportStorageError ? "save-failed" : "asr-failed";
		if (state !== "canceled") this.rememberError(job.id, error);
		try { await updateTake(job.id, { state }, CLEANUP_SIGNAL); }
		catch { this.rememberError(job.id, new ImportStorageError()); }
	}

	private rememberError(id: EntryId, error: unknown) {
		const message = error instanceof Error ? sanitizeTerminalText(error.message.replace(/\p{Bidi_Control}/gu, "")) : "";
		this.errors.set(id, message.slice(0, 512) || "Micme could not import this file.");
		if (this.errors.size > MAX_RECENT_ERRORS) this.errors.delete(this.errors.keys().next().value!);
	}
}

let service: MediaImportService | undefined;
export const importFiles: ImportFiles = (paths, choice, signal) => (service ??= new MediaImportService()).importFiles(paths, choice, signal);
export const cancelJob: CancelJob = (id) => service?.cancelJob(id);

/** Recent per-file diagnostics; recovery eligibility comes from the persisted row and verified WAV. */
export function getImportError(id: EntryId) { return service?.getImportError(id) ?? null; }
