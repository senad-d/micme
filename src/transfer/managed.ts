import { createHash, randomUUID } from "node:crypto";
import { constants, linkSync, lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { env, expandConfigPath, getAutoDownloadModel } from "../config.ts";
import { MODEL_DOWNLOAD_INACTIVITY_TIMEOUT_MS, WHISPER_VAD_MODEL } from "../constants.ts";
import { getCatalogVariant, getManagedCatalogVariant, getManagedWhisperVariant, whisperVadVariant } from "./catalog.ts";
import type { Blob, EnsureManaged, RemoveManaged, Variant } from "./contracts.ts";

export type ModelDownloadOptions = { signal?: AbortSignal; inactivityTimeoutMs?: number };
type Progress = Parameters<EnsureManaged>[2];
type Integrity = Pick<Blob, "bytes" | "sha256">;
type TransferOptions = ModelDownloadOptions & { integrity?: Integrity; blob?: Blob; resume?: boolean; onProgress?: Progress };
type AcquireOptions = ModelDownloadOptions & { missing?: string; resume?: boolean; onProgress?: Progress; onWait?: (created: boolean) => void };
type Waiter = { signal?: AbortSignal; onProgress?: Progress };
type Transfer = { controller: AbortController; promise: Promise<void>; waiters: Set<Waiter>; blob: Blob; got: number };
type ManagedErrorCode = "missing" | "integrity" | "unsafe" | "unqualified" | "unowned" | "busy";
type Directory = { path: string; stats: BigIntStats };

const downloads = new Map<string, Transfer>();
const NO_FOLLOW = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export class ModelDownloadTimeoutError extends Error {
	override name = "ModelDownloadTimeoutError";
}

export class ManagedModelError extends Error {
	override name = "ManagedModelError";
	readonly code: ManagedErrorCode;
	constructor(code: ManagedErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export function getWhisperCppModelCacheDir() {
	return expandConfigPath(env("MICME_MODEL_DIR") || join(homedir(), ".cache", "whisper.cpp"));
}

export function getConfiguredWhisperVadModelPath() {
	const path = env("MICME_VAD_MODEL")?.trim();
	return path ? resolve(expandConfigPath(path)) : undefined;
}

export function getDefaultWhisperVadModelPath() {
	return resolve(getWhisperCppModelCacheDir(), "vad", WHISPER_VAD_MODEL.file);
}

function sameBlob(a: Blob, b: Blob) {
	return a.path === b.path && a.url === b.url && a.revision === b.revision && a.bytes === b.bytes && a.sha256 === b.sha256;
}

function qualifiedVariant(variant: Variant) {
	if (variant.rights !== "cleared" || variant.runtime !== "passed" || !variant.blobs.length) return null;
	const vad = whisperVadVariant();
	if (variant.id === vad.id) return vad;
	const standard = getCatalogVariant(variant.id);
	const name = standard && /^whisper\.cpp\/([^/]+)\//.exec(standard.id)?.[1];
	if (name) return getManagedWhisperVariant(name);
	const actualCompute = variant.traits?.actualCompute;
	if (!actualCompute || actualCompute === "unknown") return null;
	for (const { rig, device, task, language } of variant.measurements) {
		const observed = getManagedCatalogVariant(variant.id, { rig, actualCompute, device }, task, language);
		if (observed) return observed;
	}
	return null;
}

function managedFiles(variant: Variant) {
	const pinned = qualifiedVariant(variant);
	if (!pinned || pinned.blobs.length !== variant.blobs.length || !pinned.blobs.every((blob, i) => sameBlob(blob, variant.blobs[i]) && safeBlobLeaf(blob.path))) {
		throw new ManagedModelError("unqualified", "Micme requires a qualified exact catalog artifact.");
	}
	const vad = pinned.id === whisperVadVariant().id;
	const root = resolve(getWhisperCppModelCacheDir());
	// A variant gets one directory directly under the configured root. There is no
	// intermediate app-owned pathname that could redirect lookup to another tree.
	const directory = pinned.id.startsWith("whisper.cpp/") ? root : join(root, `.micme-managed-${key(pinned.id)}`);
	return pinned.blobs.map((blob) => ({ blob, target: vad ? getDefaultWhisperVadModelPath() : join(directory, blob.path), resume: !vad }));
}

/** Resolve the first (primary) blob only after all blobs of the exact variant verify. */
export const ensureManaged: EnsureManaged = async (variant, download, progress, signal) => {
	signal.throwIfAborted();
	const files = managedFiles(variant);
	const total = files.reduce((bytes, { blob }) => bytes + blob.bytes, 0);
	let verified = 0;
	progress(0, total);
	for (const { blob, target, resume } of files) {
		await ensurePinnedModelFile(blob, target, {
			signal, resume,
			missing: isExplicitModelPath(target) ? `Micme will not write to an explicit model path: ${target}` : managedMissingMessage(target, download),
			onProgress: (got) => progress(verified + got, total),
		});
		signal.throwIfAborted();
		verified += blob.bytes;
		progress(verified, total);
	}
	signal.throwIfAborted();
	return files[0].target;
};

function managedMissingMessage(target: string, allowDownload: boolean) {
	if (!allowDownload) return `Micme model is missing: ${target}. Authorize the download or install the exact artifact for offline use.`;
	if (!getAutoDownloadModel()) return `Micme model is missing and auto-download is disabled: ${target}. Install the exact artifact or enable MICME_AUTO_DOWNLOAD_MODEL.`;
	return undefined;
}

/** Low-level acquisition for the catalog-backed legacy resolver; a missing message forbids network/writes. */
export async function ensurePinnedModelFile(blob: Blob, path: string, options: AcquireOptions) {
	options.signal?.throwIfAborted();
	const target = resolve(path);
	if (await verifyFile(target, blob, options.signal)) return;
	if (options.missing) throw new ManagedModelError("missing", options.missing);
	let transfer = downloads.get(target);
	while (transfer?.controller.signal.aborted) {
		await waitWithSignal(transfer.promise.catch(ignoreCleanupError), options.signal);
		transfer = downloads.get(target);
	}
	options.signal?.throwIfAborted();
	const created = !transfer;
	transfer ??= startTransfer(blob, target, options);
	if (!sameBlob(transfer.blob, blob)) throw new ManagedModelError("busy", `Micme is already downloading a different artifact to ${target}.`);
	const waiter: Waiter = { signal: options.signal, onProgress: options.onProgress };
	transfer.waiters.add(waiter);
	try {
		options.onWait?.(created);
		if (transfer.got) notifyProgress(waiter, transfer.got, blob.bytes);
		await waitWithSignal(transfer.promise, options.signal);
		options.signal?.throwIfAborted();
	} finally {
		transfer.waiters.delete(waiter);
		if (!transfer.waiters.size && downloads.get(target) === transfer) {
			transfer.controller.abort();
			await transfer.promise.catch(ignoreCleanupError);
		}
	}
}

function startTransfer(blob: Blob, target: string, options: AcquireOptions) {
	const controller = new AbortController();
	const transfer: Transfer = { controller, promise: Promise.resolve(), waiters: new Set(), blob, got: 0 };
	transfer.promise = downloadFile(blob.url, target, {
		...options, blob, signal: controller.signal,
		onProgress: reportProgress.bind(undefined, transfer),
	}).finally(() => { if (downloads.get(target) === transfer) downloads.delete(target); });
	downloads.set(target, transfer);
	return transfer;
}

function reportProgress(transfer: Transfer, got: number, total: number) {
	transfer.got = got;
	for (const waiter of transfer.waiters) notifyProgress(waiter, got, total);
}

function notifyProgress(waiter: Waiter, got: number, total: number) {
	if (waiter.signal?.aborted) return;
	try { waiter.onProgress?.(got, total); } catch { /* A view cannot cancel other waiters. */ }
}

/** The caller supplies consent before invoking removal. Never unlink a name alone. */
export const removeManaged: RemoveManaged = async (variant, signal) => {
	signal.throwIfAborted();
	removePinnedModelFiles(managedFiles(variant), signal);
};

/** Low-level removal: preflight every member before touching any of the installed files. */
export function removePinnedModelFiles(files: readonly { blob: Blob; target: string }[], signal: AbortSignal) {
	signal.throwIfAborted();
	for (const file of files.map(({ blob, target }) => prepareRemoval(blob, resolve(target)))) {
		signal.throwIfAborted();
		if (!file) continue;
		const { target, stats, receipt, partial, checkpoint, state, parent } = file;
		assertDirectory(parent);
		assertDirectory(state);
		if (stats && receipt) {
			assertUnchanged(target, stats);
			unlinkSync(target);
			unlinkSync(receipt);
		}
		if (checkpoint) {
			assertUnchanged(partial, checkpoint);
			unlinkSync(partial);
		}
		try { rmdirSync(state.path); } catch (error) { if (!hasCode(error, "ENOTEMPTY") && !hasCode(error, "ENOENT")) throw error; }
	}
}

function prepareRemoval(blob: Blob, target: string) {
	if (downloads.has(target)) throw new ManagedModelError("busy", `Micme is still downloading ${basename(target)}.`);
	if (isExplicitModelPath(target)) {
		throw new ManagedModelError("unowned", `Micme will not remove an explicit model path: ${target}`);
	}
	const parent = directoryAt(dirname(target));
	if (!parent) return null;
	if (process.getuid && (parent.stats.uid !== BigInt(process.getuid()) || (parent.stats.mode & 0o022n) !== 0n)) {
		throw new ManagedModelError("unsafe", `Micme will not remove files from an unowned or shared writable model cache: ${parent.path}`);
	}
	const state = privateState(blob, target, false);
	const stats = regularAt(target);
	const receipt = stats && state && receiptPath(state, stats);
	if (stats && (!receipt || !regularAt(receipt))) {
		throw new ManagedModelError("unowned", `Micme did not install this file; remove or move it yourself: ${target}`);
	}
	if (!state) return null;
	const partial = join(state.path, "partial");
	return { target, stats, receipt, partial, checkpoint: regularAt(partial), state, parent };
}

function isExplicitModelPath(target: string) {
	const explicit = env("MICME_WHISPER_CPP_MODEL")?.trim();
	const overrides = [explicit && resolve(expandConfigPath(explicit)), getConfiguredWhisperVadModelPath()];
	if (overrides.includes(target)) return true;
	if (!overrides.some(Boolean)) return false;
	const actual = tryRealpath(target);
	return actual !== undefined && overrides.some((path) => path && tryRealpath(path) === actual);
}

function tryRealpath(path: string) {
	try { return realpathSync(path); } catch (error) {
		if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR") && !hasCode(error, "ELOOP")) throw error;
	}
}

function safeBlobLeaf(path: string) {
	return path !== "." && path !== ".." && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(path);
}

function key(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function privateState(blob: Blob, target: string, create: boolean) {
	const path = join(dirname(target), `.micme-${key(JSON.stringify([blob.url, blob.revision, blob.path, blob.bytes, blob.sha256]))}`);
	if (create) {
		try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
	}
	const state = directoryAt(path);
	if (state && process.getuid && (state.stats.uid !== BigInt(process.getuid()) || (state.stats.mode & 0o077n) !== 0n)) {
		throw new ManagedModelError("unsafe", `Micme transfer state is not private: ${path}`);
	}
	return state;
}

function receiptPath(state: Directory, stats: BigIntStats) {
	// Birth time prevents a reused inode from making a later manual file removable.
	return stats.birthtimeNs ? join(state.path, `owned-${stats.dev}-${stats.ino}-${stats.birthtimeNs}`) : undefined;
}

export function hasCode(error: unknown, code: string) {
	return error instanceof Error && "code" in error && error.code === code;
}

function sameIdentity(a: BigIntStats, b: BigIntStats) {
	return a.dev === b.dev && a.ino === b.ino;
}

function unchanged(a: BigIntStats, b: BigIntStats) {
	return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function directoryAt(path: string): Directory | undefined {
	const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	if (!stats) return undefined;
	if (!stats.isDirectory()) throw new ManagedModelError("unsafe", `Micme model directory is not a regular directory: ${path}`);
	return { path, stats };
}

function assertDirectory(dir: Directory) {
	const current = directoryAt(dir.path);
	if (!current || !sameIdentity(current.stats, dir.stats)) throw changed(dir.path);
}

function regularAt(path: string, label = "Micme model path") {
	const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	if (stats && !stats.isFile()) throw new ManagedModelError("unsafe", `${label} exists but is not a file (links are not accepted): ${path}`);
	return stats;
}

function assertUnchanged(path: string, before: BigIntStats) {
	const current = regularAt(path);
	if (!current || !unchanged(before, current)) throw changed(path);
}

function changed(path: string) {
	return new ManagedModelError("unsafe", `Micme model file or directory changed during verification: ${path}`);
}

async function verifyFile(path: string, integrity: Integrity, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const parent = directoryAt(dirname(path));
	const entry = parent && regularAt(path, basename(path) === WHISPER_VAD_MODEL.file ? "Micme VAD model path" : undefined);
	if (!parent || !entry) return false;
	const file = await open(path, constants.O_RDONLY | NO_FOLLOW);
	try {
		await verifyHandle(file, path, path, entry, integrity, signal);
	} finally {
		await file.close();
	}
	signal?.throwIfAborted();
	assertDirectory(parent);
	assertUnchanged(path, entry);
	return true;
}

async function verifyHandle(file: FileHandle, path: string, target: string, entry: BigIntStats, integrity: Integrity, signal?: AbortSignal) {
	const before = await file.stat({ bigint: true });
	if (!before.isFile() || !unchanged(entry, before)) throw changed(path);
	if (before.size !== BigInt(integrity.bytes)) throw badSize(target, integrity.bytes);
	const hash = createHash("sha256");
	let count = 0;
	// Read at most one extra byte even if the underlying file grows.
	for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: integrity.bytes, signal })) {
		hash.update(chunk);
		count += chunk.byteLength;
	}
	signal?.throwIfAborted();
	if (count !== integrity.bytes) throw badSize(target, integrity.bytes);
	if (hash.digest("hex") !== integrity.sha256) {
		throw new ManagedModelError("integrity", `Micme model SHA-256 mismatch: ${target}. Move or remove the invalid cached file before retrying.`);
	}
	const after = await file.stat({ bigint: true });
	if (!unchanged(before, after)) throw changed(path);
	assertUnchanged(path, after);
	return after;
}

function badSize(target: string, size: number) {
	return new ManagedModelError("integrity", `Micme model size mismatch for ${target} (expected ${size} bytes). Move or remove any invalid cached file before retrying.`);
}

function cacheHasFile(target: string, integrity: Integrity | undefined, signal?: AbortSignal) {
	return integrity ? verifyFile(target, integrity, signal) : Boolean(regularAt(target, "Download target"));
}

export async function downloadFile(url: string, path: string, options: TransferOptions = {}) {
	const target = resolve(path);
	options.signal?.throwIfAborted();
	const integrity = options.blob ?? options.integrity;
	if (await cacheHasFile(target, integrity, options.signal)) return;
	options.signal?.throwIfAborted();
	const timeoutMs = getTimeout(options.inactivityTimeoutMs);
	const timeout = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
	const temp = `${target}.download-${randomUUID()}`;
	const resume = options.resume !== false && options.blob;
	const parentPath = dirname(target);
	mkdirSync(parentPath, { recursive: true, mode: 0o700 });
	const parent = directoryAt(parentPath)!;
	let file: FileHandle | undefined;
	let identity: BigIntStats | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let offset = 0;
	let mayCheckpoint = false;

	try {
		const checkpoint = resume && claimPartial(resume, parent, target, temp);
		if (checkpoint) {
			identity = checkpoint;
			file = await open(temp, constants.O_RDWR | NO_FOLLOW);
			const held = await file.stat({ bigint: true });
			if (!unchanged(held, checkpoint)) throw changed(temp);
			offset = Number(held.size);
			mayCheckpoint = true;
		}
		let response = await fetchFile(url, offset, signal, timeout, timeoutMs);
		if (resume && file && offset && !isRangeResponse(response, offset, resume)) {
			const alreadyFull = isFullResponse(response, resume);
			if (!alreadyFull) cancelBody(response);
			else reader = response.body?.getReader();
			mayCheckpoint = false;
			offset = 0;
			await file.truncate(0);
			if (!alreadyFull) response = await fetchFile(url, 0, signal, timeout, timeoutMs);
		}
		assertResponse(response, offset, integrity);
		reader ??= response.body?.getReader();
		if (!reader || (!integrity && !response.ok)) {
			throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
		}
		assertDirectory(parent);
		if (!file) {
			file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW, 0o600);
			identity = await file.stat({ bigint: true });
		}
		const total = integrity?.bytes ?? Number(response.headers.get("content-length") || "0");
		let lastUpdate = 0;
		options.onProgress?.(offset, total);
		while (true) {
			mayCheckpoint = true;
			const result = await activity(reader.read(), signal, timeout, timeoutMs, "response body data");
			if (result.done) break;
			if (!result.value?.byteLength) continue;
			mayCheckpoint = false;
			if (integrity && offset + result.value.byteLength > total) throw badSize(target, total);
			offset = await activity(writeChunk(file, result.value, offset, signal), signal, timeout, timeoutMs, "file output");
			const now = Date.now();
			if (now - lastUpdate > 1_000) {
				options.onProgress?.(offset, total);
				lastUpdate = now;
			}
		}
		signal.throwIfAborted();
		if (integrity && offset !== total) throw badSize(target, total);
		mayCheckpoint = false;
		const stats = await file.stat({ bigint: true });
		const verified = integrity ? await verifyHandle(file, temp, target, stats, integrity, signal) : stats;
		assertDirectory(parent);
		assertUnchanged(temp, verified);
		signal.throwIfAborted();
		if (!publish(temp, target, verified, options.blob) && !await cacheHasFile(target, integrity, signal)) throw changed(target);
		options.onProgress?.(offset, total);
	} catch (error) {
		if (resume && file && mayCheckpoint && offset > 0 && offset < resume.bytes) {
			await keepPartial(resume, parent, target, temp, file, offset).catch(ignoreCleanupError);
		}
		throw error;
	} finally {
		if (reader) void reader.cancel().catch(ignoreCleanupError);
		try { await file?.close(); } finally { if (identity) cleanupTemp(parent, temp, identity); }
	}
}

function assertResponse(response: Response, offset: number, integrity: Integrity | undefined) {
	if (!integrity || (offset ? isRangeResponse(response, offset, integrity) : isFullResponse(response, integrity))) return;
	cancelBody(response);
	throw new Error(`Micme model response has an unexpected HTTP status or byte range (HTTP ${response.status}).`);
}

function fetchFile(url: string, offset: number, signal: AbortSignal, timeout: AbortController, timeoutMs: number) {
	signal.throwIfAborted();
	const headers: Record<string, string> = { "Accept-Encoding": "identity" };
	if (offset) headers.Range = `bytes=${offset}-`;
	return activity(fetch(url, { signal, headers, credentials: "omit" }), signal, timeout, timeoutMs, "response headers");
}

function matchingLength(response: Response, bytes: number) {
	const encoding = response.headers.get("content-encoding");
	const length = response.headers.get("content-length");
	return (!encoding || encoding.toLowerCase() === "identity") && (length === null || length === String(bytes));
}

function isFullResponse(response: Response, integrity: Integrity | undefined) {
	return response.status === 200 && response.headers.get("content-range") === null && (!integrity || matchingLength(response, integrity.bytes));
}

function isRangeResponse(response: Response, offset: number, integrity: Integrity) {
	return response.status === 206 && matchingLength(response, integrity.bytes - offset)
		&& response.headers.get("content-range") === `bytes ${offset}-${integrity.bytes - 1}/${integrity.bytes}`;
}

function cancelBody(response: Response) {
	if (response.body) void response.body.cancel().catch(ignoreCleanupError);
}

async function writeChunk(file: FileHandle, bytes: Uint8Array, offset: number, signal: AbortSignal) {
	let written = 0;
	while (written < bytes.byteLength) {
		signal.throwIfAborted();
		const result = await file.write(bytes, written, bytes.byteLength - written, offset + written);
		if (!result.bytesWritten) throw new Error("Micme could not write the model download.");
		written += result.bytesWritten;
	}
	return offset + written;
}

function claimPartial(blob: Blob, parent: Directory, target: string, temp: string) {
	const state = privateState(blob, target, false);
	if (!state) return undefined;
	const partial = join(state.path, "partial");
	const entry = regularAt(partial);
	if (!entry) return undefined;
	assertDirectory(parent);
	assertDirectory(state);
	const current = regularAt(partial);
	if (!current) return undefined; // Another Pi process may already have claimed it.
	if (!unchanged(current, entry)) throw changed(partial);
	try { renameSync(partial, temp); } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
	const moved = regularAt(temp);
	if (!moved || !sameIdentity(entry, moved)) throw changed(temp);
	if (moved.size <= 0n || moved.size >= BigInt(blob.bytes)) {
		unlinkSync(temp);
		return undefined;
	}
	return moved;
}

async function keepPartial(blob: Blob, parent: Directory, target: string, temp: string, file: FileHandle, offset: number) {
	const stats = await file.stat({ bigint: true });
	if (!stats.isFile() || stats.size !== BigInt(offset)) return;
	assertDirectory(parent);
	assertUnchanged(temp, stats);
	const state = privateState(blob, target, true)!;
	// A checkpoint is immutable while parked. Its exact size is the resume offset;
	// its private directory keys it to the entire ledger blob, not just a filename.
	assertDirectory(state);
	try { linkSync(temp, join(state.path, "partial")); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
}

function publish(temp: string, target: string, stats: BigIntStats, blob?: Blob) {
	const state = blob && privateState(blob, target, true);
	const receipt = state && receiptPath(state, stats);
	if (receipt) writeFileSync(receipt, "", { flag: "wx", mode: 0o600 });
	try {
		linkSync(temp, target); // Atomic publication; never overwrite a concurrent install or manual path.
		return true;
	} catch (error) {
		if (receipt) unlinkSync(receipt);
		if (!hasCode(error, "EEXIST")) throw error;
		return false;
	}
}

function cleanupTemp(parent: Directory, temp: string, identity: BigIntStats) {
	try {
		assertDirectory(parent);
		const current = regularAt(temp);
		if (current && sameIdentity(current, identity)) unlinkSync(temp);
	} catch { /* Never clean through a replacement directory or leaf. */ }
}

function getTimeout(ms = MODEL_DOWNLOAD_INACTIVITY_TIMEOUT_MS) {
	if (!Number.isFinite(ms) || ms <= 0) throw new Error("inactivityTimeoutMs must be a positive finite number");
	return Math.ceil(ms);
}

async function activity<T>(work: Promise<T>, signal: AbortSignal, controller: AbortController, ms: number, step: string) {
	const timer = setTimeout(() => controller.abort(new ModelDownloadTimeoutError(`Micme model download timed out after ${ms} ms without ${step}.`)), ms);
	try { return await waitWithSignal(work, signal); } finally { clearTimeout(timer); }
}

async function waitWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) {
		void work.catch(ignoreCleanupError);
		signal.throwIfAborted();
	}
	let rejectAbort: (reason: unknown) => void;
	const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	const onAbort = () => rejectAbort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try { return await Promise.race([work, aborted]); } finally { signal.removeEventListener("abort", onAbort); }
}

function ignoreCleanupError() {
	// Best-effort cleanup does not replace the original failure.
}
