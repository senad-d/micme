import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, readdirSync, statSync, type WriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { finished } from "node:stream/promises";
import {
	DEFAULT_PYTHON_WHISPER_MODEL_NAME,
	DEFAULT_WHISPER_CPP_MODEL_NAME,
	MODEL_DOWNLOAD_INACTIVITY_TIMEOUT_MS,
	PYTHON_WHISPER_MODEL_NAMES,
	STATUS_KEY,
	WHISPER_CPP_MODEL_BASE_URL,
	WHISPER_CPP_MODEL_NAMES,
} from "./constants.ts";
import { env, expandConfigPath, getAutoDownloadModel, getTranslateToEnglishLanguage } from "./config.ts";
import { findExecutable, runProcess } from "./processes.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ModelCandidate, ResolvedWhisperCppModel } from "./types.ts";

export type ModelDownloadOptions = {
	signal?: AbortSignal;
	inactivityTimeoutMs?: number;
};

type DownloadFileOptions = ModelDownloadOptions & {
	onProgress?: (downloadedBytes: number, totalBytes: number) => void;
};

type ModelDownloadWaiter = {
	ctx?: ExtensionContext;
	signal?: AbortSignal;
};

type SharedModelDownload = {
	controller: AbortController;
	promise: Promise<void>;
	waiters: Map<symbol, ModelDownloadWaiter>;
	settled: boolean;
};

export class ModelDownloadTimeoutError extends Error {
	override name = "ModelDownloadTimeoutError";
}

const modelDownloads = new Map<string, SharedModelDownload>();
const PYTHON_WHISPER_MODELS_SCRIPT = String.raw`import whisper; print('\n'.join(whisper.available_models()))`;

export function discoverWhisperCppModels(cwd: string): ModelCandidate[] {
	const candidates: ModelCandidate[] = [];
	const seen = new Set<string>();
	const add = (candidate: ModelCandidate) => {
		const key = candidate.value;
		if (!key || seen.has(key)) return;
		seen.add(key);
		candidates.push(candidate);
	};

	const current = env("MICME_WHISPER_CPP_MODEL");
	if (current) {
		const expanded = expandConfigPath(current);
		const installed = isRegularFile(expanded);
		add({
			label: basename(expanded),
			value: expanded,
			description: installed ? `current explicit path: ${expanded}` : `current explicit path is missing or not a file: ${expanded}`,
			installed,
			kind: "path",
		});
	}

	for (const file of scanModelFiles(cwd)) {
		add({ label: basename(file), value: file, description: file, installed: true, kind: "path" });
	}

	const cacheDir = getWhisperCppModelCacheDir();
	for (const modelName of WHISPER_CPP_MODEL_NAMES) {
		const path = join(cacheDir, `ggml-${modelName}.bin`);
		const installed = isRegularFile(path);
		add({
			label: modelName,
			value: path,
			description: `${describeWhisperModel(modelName)} • ${basename(path)}${installed ? "" : " (expected path; download model first)"}`,
			installed,
			kind: "model-name",
		});
	}

	return candidates.sort((a, b) => Number(b.installed) - Number(a.installed) || a.label.localeCompare(b.label));
}

export function scanModelFiles(cwd: string) {
	const directories = new Set<string>();
	const addDir = (path: string | undefined) => {
		if (path) directories.add(expandConfigPath(path));
	};

	addDir(env("MICME_MODEL_DIR"));
	const currentModel = env("MICME_WHISPER_CPP_MODEL");
	if (currentModel) addDir(dirname(expandConfigPath(currentModel)));
	addDir(join(cwd, "models"));
	addDir(join(cwd, ".micme", "models"));
	addDir(join(homedir(), ".cache", "whisper.cpp"));
	addDir(join(homedir(), ".cache", "whisper"));

	const files: string[] = [];
	for (const directory of directories) {
		scanModelDirectory(directory, files, 0);
	}
	return files;
}

export function scanModelDirectory(directory: string, files: string[], depth: number) {
	if (depth > 3 || !existsSync(directory)) return;
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return;
	}

	for (const entry of entries) {
		const path = join(directory, entry);
		let stats;
		try {
			stats = statSync(path);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			scanModelDirectory(path, files, depth + 1);
			continue;
		}
		if (/^ggml-.+\.(bin|gguf)$/i.test(entry)) files.push(path);
	}
}

export function describeWhisperModel(name: string) {
	if (name.startsWith("tiny")) return "fastest, lowest accuracy";
	if (name.startsWith("base")) return "fast baseline";
	if (name.startsWith("small")) return "recommended stronger local model";
	if (name.startsWith("medium")) return "stronger, slower";
	if (name.includes("turbo")) return "large-v3 turbo, strong but larger";
	if (name.startsWith("large")) return "highest accuracy, slowest/largest";
	return "Whisper model";
}

export function resolveWhisperCppModel(): ResolvedWhisperCppModel {
	const explicitPath = env("MICME_WHISPER_CPP_MODEL")?.trim();
	if (explicitPath) return resolveExplicitWhisperCppModel(expandConfigPath(explicitPath), explicitPath);

	const configuredName = env("MICME_DEFAULT_WHISPER_CPP_MODEL")?.trim();
	const rawModelName = configuredName || DEFAULT_WHISPER_CPP_MODEL_NAME;
	const modelName = getTranslationAwareWhisperModelName(rawModelName);
	const path = join(getWhisperCppModelCacheDir(), `ggml-${modelName}.bin`);
	return buildResolvedWhisperCppModel(path, {
		modelName,
		source: configuredName ? "configured-name" : "default-name",
		configuredValue: configuredName,
		translationFallbackFrom: getTranslationFallbackSource(rawModelName, modelName),
	});
}

function resolveExplicitWhisperCppModel(path: string, configuredValue: string): ResolvedWhisperCppModel {
	const modelName = getWhisperCppModelNameFromPath(path);
	const translationModelName = modelName ? getTranslationAwareWhisperModelName(modelName) : undefined;
	if (modelName && translationModelName && translationModelName !== modelName) {
		const fallbackPath = getSiblingWhisperCppModelPath(path, translationModelName);
		return buildResolvedWhisperCppModel(fallbackPath, {
			modelName: translationModelName,
			source: "explicit-path",
			configuredValue,
			translationFallbackFrom: modelName,
		});
	}

	return buildResolvedWhisperCppModel(path, {
		modelName,
		source: "explicit-path",
		configuredValue,
	});
}

function buildResolvedWhisperCppModel(
	path: string,
	metadata: Pick<ResolvedWhisperCppModel, "source"> & Pick<Partial<ResolvedWhisperCppModel>, "modelName" | "configuredValue" | "translationFallbackFrom">,
): ResolvedWhisperCppModel {
	return {
		path,
		modelName: metadata.modelName,
		source: metadata.source,
		configuredValue: metadata.configuredValue,
		exists: isRegularFile(path),
		downloadable: isDownloadableWhisperCppModelPath(path),
		translationFallbackFrom: metadata.translationFallbackFrom,
	};
}

function getSiblingWhisperCppModelPath(modelPath: string, modelName: string) {
	const extension = extname(modelPath) || ".bin";
	return join(dirname(modelPath), `ggml-${modelName}${extension}`);
}

function getTranslationFallbackSource(rawModelName: string, modelName: string) {
	return rawModelName === modelName ? undefined : rawModelName;
}

export function getPythonWhisperModelName() {
	const modelName = env("MICME_WHISPER_MODEL")?.trim() || DEFAULT_PYTHON_WHISPER_MODEL_NAME;
	return getTranslationAwareWhisperModelName(modelName);
}

export function getTranslationAwareWhisperModelName(modelName: string) {
	return getTranslateToEnglishLanguage() ? toTranslationCapableWhisperModelName(modelName) : modelName;
}

export function toTranslationCapableWhisperModelName(modelName: string) {
	const multilingualName = toMultilingualWhisperModelName(modelName);
	return isTranslationUnsupportedWhisperModelName(multilingualName) ? "large-v3" : multilingualName;
}

export function toMultilingualWhisperModelName(modelName: string) {
	return modelName.replace(/\.en$/i, "");
}

export function isEnglishOnlyWhisperModelName(modelName: string | undefined) {
	return Boolean(modelName && /\.en$/i.test(modelName));
}

export function isTranslationUnsupportedWhisperModelName(modelName: string | undefined) {
	if (modelName) {
		const normalized = modelName.toLowerCase();
		return normalized === "turbo" || normalized === "large-v3-turbo" || normalized.startsWith("large-v3-turbo-");
	}
	return false;
}

export async function discoverPythonWhisperModels(): Promise<ModelCandidate[]> {
	const dynamicNames = await queryPythonWhisperModelNames();
	const names = dynamicNames.length > 0 ? dynamicNames : [...PYTHON_WHISPER_MODEL_NAMES];
	const source = dynamicNames.length > 0 ? "reported by whisper.available_models()" : "built-in fallback list";
	return names.map((name) => ({
		label: name,
		value: name,
		description: `${describeWhisperModel(name)} • ${source}`,
		installed: dynamicNames.length > 0,
		kind: "model-name",
	}));
}

export async function queryPythonWhisperModelNames(): Promise<string[]> {
	const python = findExecutable(["python3", "python"]);
	if (!python) return [];

	try {
		const result = await runProcess(python, getPythonWhisperModelQueryArgs(), 2_000);
		if (result.code !== 0 || result.timedOut) return [];
		return uniqueModelNames(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
	} catch {
		return [];
	}
}

export function getPythonWhisperModelQueryArgs() {
	// Isolated mode prevents project-local Python files (for example ./whisper.py) or PYTHONPATH from executing during model discovery.
	return ["-I", "-c", PYTHON_WHISPER_MODELS_SCRIPT];
}

export function uniqueModelNames(names: string[]) {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const name of names) {
		const normalized = name.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		output.push(normalized);
	}
	return output;
}

export async function ensureWhisperCppModel(modelPath: string, ctx?: ExtensionContext, options: ModelDownloadOptions & { allowDownload?: boolean } = {}) {
	options.signal?.throwIfAborted();
	assertDownloadTargetIsUsable(modelPath, "Micme model path");
	if (isRegularFile(modelPath)) return;
	if (options.allowDownload === false) {
		throw new Error(`Micme model is missing: ${modelPath}`);
	}
	if (!getAutoDownloadModel()) {
		throw new Error(`Micme model is missing and auto-download is disabled: ${modelPath}`);
	}

	const modelName = getDownloadableWhisperCppModelName(modelPath);
	if (!modelName) {
		throw new Error(`Micme model is missing and cannot infer a standard download URL: ${modelPath}`);
	}

	let download = modelDownloads.get(modelPath);
	if (download?.controller.signal.aborted) download = await waitForActiveModelDownload(modelPath, download, options.signal);
	const created = !download;
	if (!download) download = createSharedModelDownload(modelName, modelPath, options.inactivityTimeoutMs);
	await waitForSharedModelDownload(download, modelPath, ctx, options.signal, created);
}

export async function downloadWhisperCppModel(modelName: string, modelPath: string, ctx?: ExtensionContext, options: ModelDownloadOptions = {}) {
	options.signal?.throwIfAborted();
	assertDownloadTargetIsUsable(modelPath, "Micme model path");
	if (isRegularFile(modelPath)) return;
	const displayName = safeBasename(modelPath);
	setActiveDownloadStatus(ctx, options.signal, `downloading ${displayName}…`);
	if (!options.signal?.aborted) ctx?.ui.notify(`Downloading ${displayName}. This can take a while the first time.`, "info");

	try {
		await performWhisperCppModelDownload(modelName, modelPath, {
			...options,
			onProgress: updateContextDownloadProgress.bind(undefined, ctx, options.signal, modelPath),
		});
		options.signal?.throwIfAborted();
		ctx?.ui.notify(`Downloaded ${displayName}.`, "info");
	} finally {
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function performWhisperCppModelDownload(modelName: string, modelPath: string, options: DownloadFileOptions) {
	assertDownloadTargetIsUsable(modelPath, "Micme model path");
	if (isRegularFile(modelPath)) return;
	await downloadFile(getWhisperCppModelUrl(modelName), modelPath, undefined, options);
}

export async function downloadFile(url: string, targetPath: string, ctx?: ExtensionContext, options: DownloadFileOptions = {}) {
	options.signal?.throwIfAborted();
	assertDownloadTargetIsUsable(targetPath, "Download target");
	if (isRegularFile(targetPath)) return;
	await mkdir(dirname(targetPath), { recursive: true });
	const tempPath = `${targetPath}.download-${process.pid}-${Date.now()}-${randomUUID()}`;
	const timeoutMs = getDownloadInactivityTimeout(options.inactivityTimeoutMs);
	const timeoutController = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let output: WriteStream | undefined;
	let outputFinished: Promise<void> | undefined;
	let downloadedBytes = 0;
	let lastUpdate = 0;

	try {
		const response = await waitForDownloadActivity(fetch(url, { signal }), signal, timeoutController, timeoutMs, "response headers");
		if (!response.ok || !response.body) {
			throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
		}

		const totalBytes = Number(response.headers.get("content-length") || "0");
		reader = response.body.getReader();
		output = createWriteStream(tempPath, { flags: "wx" });
		outputFinished = finished(output);
		outputFinished.catch(ignoreDownloadFailure);

		while (true) {
			const result = await waitForDownloadActivity(reader.read(), signal, timeoutController, timeoutMs, "response body data");
			if (result.done) break;
			if (!result.value) continue;
			downloadedBytes += result.value.byteLength;
			await waitForDownloadActivity(writeDownloadChunk(output, Buffer.from(result.value), outputFinished), signal, timeoutController, timeoutMs, "file output");

			const now = Date.now();
			if (now - lastUpdate > 1_000) {
				updateContextDownloadProgress(ctx, options.signal, targetPath, downloadedBytes, totalBytes);
				options.onProgress?.(downloadedBytes, totalBytes);
				lastUpdate = now;
			}
		}

		output.end();
		await waitForDownloadActivity(outputFinished, signal, timeoutController, timeoutMs, "file completion");
		if (isRegularFile(targetPath)) {
			await unlink(tempPath).catch(ignoreDownloadFailure);
			return;
		}
		assertDownloadTargetIsUsable(targetPath, "Download target");
		options.signal?.throwIfAborted();
		await rename(tempPath, targetPath);
	} catch (error) {
		cancelDownloadReader(reader);
		output?.destroy();
		if (outputFinished) await outputFinished.catch(ignoreDownloadFailure);
		await unlink(tempPath).catch(ignoreDownloadFailure);
		throw error;
	}
}

function createSharedModelDownload(modelName: string, modelPath: string, inactivityTimeoutMs: number | undefined) {
	const controller = new AbortController();
	const download: SharedModelDownload = {
		controller,
		promise: Promise.resolve(),
		waiters: new Map(),
		settled: false,
	};
	const options: DownloadFileOptions = {
		signal: controller.signal,
		inactivityTimeoutMs,
		onProgress: reportSharedModelDownloadProgress.bind(undefined, download, modelPath),
	};
	download.promise = performWhisperCppModelDownload(modelName, modelPath, options).finally(settleSharedModelDownload.bind(undefined, modelPath, download));
	download.promise.catch(ignoreDownloadFailure);
	modelDownloads.set(modelPath, download);
	return download;
}

async function waitForActiveModelDownload(modelPath: string, download: SharedModelDownload | undefined, signal: AbortSignal | undefined) {
	while (download?.controller.signal.aborted) {
		try {
			await waitForPromiseWithSignal(download.promise, signal);
		} catch {
			signal?.throwIfAborted();
		}
		download = modelDownloads.get(modelPath);
	}
	return download;
}

async function waitForSharedModelDownload(download: SharedModelDownload, modelPath: string, ctx: ExtensionContext | undefined, signal: AbortSignal | undefined, created: boolean) {
	const waiterId = Symbol(modelPath);
	download.waiters.set(waiterId, { ctx, signal });
	const displayName = safeBasename(modelPath);
	setActiveDownloadStatus(ctx, signal, created ? `downloading ${displayName}…` : `waiting for ${displayName} download…`);
	if (created && !signal?.aborted) ctx?.ui.notify(`Downloading ${displayName}. This can take a while the first time.`, "info");
	let failed = false;
	let failure: unknown;

	try {
		await waitForPromiseWithSignal(download.promise, signal);
		signal?.throwIfAborted();
		ctx?.ui.notify(`Downloaded ${displayName}.`, "info");
	} catch (error) {
		failed = true;
		failure = error;
	} finally {
		download.waiters.delete(waiterId);
		ctx?.ui.setStatus(STATUS_KEY, undefined);
		if (download.waiters.size === 0 && !download.settled) {
			download.controller.abort();
			await download.promise.catch(ignoreDownloadFailure);
		}
	}

	if (failed) throw failure;
}

function reportSharedModelDownloadProgress(download: SharedModelDownload, modelPath: string, downloadedBytes: number, totalBytes: number) {
	for (const waiter of download.waiters.values()) {
		updateContextDownloadProgress(waiter.ctx, waiter.signal, modelPath, downloadedBytes, totalBytes);
	}
}

function updateContextDownloadProgress(ctx: ExtensionContext | undefined, signal: AbortSignal | undefined, modelPath: string, downloadedBytes: number, totalBytes: number) {
	setActiveDownloadStatus(ctx, signal, `downloading ${safeBasename(modelPath)} ${formatDownloadProgress(downloadedBytes, totalBytes)}`);
}

function setActiveDownloadStatus(ctx: ExtensionContext | undefined, signal: AbortSignal | undefined, status: string) {
	if (!signal?.aborted) ctx?.ui.setStatus(STATUS_KEY, status);
}

function settleSharedModelDownload(modelPath: string, download: SharedModelDownload) {
	download.settled = true;
	if (modelDownloads.get(modelPath) === download) modelDownloads.delete(modelPath);
}

async function waitForDownloadActivity<T>(work: Promise<T>, signal: AbortSignal, timeoutController: AbortController, timeoutMs: number, activity: string) {
	const timeout = setTimeout(() => {
		timeoutController.abort(new ModelDownloadTimeoutError(`Micme model download timed out after ${timeoutMs} ms without ${activity}.`));
	}, timeoutMs);
	try {
		return await waitForPromiseWithSignal(work, signal);
	} finally {
		clearTimeout(timeout);
	}
}

async function waitForPromiseWithSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return work;
	signal.throwIfAborted();
	let rejectAbort: (reason?: unknown) => void = ignoreDownloadFailure;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => rejectAbort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([work, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function getDownloadInactivityTimeout(value: number | undefined) {
	if (value === undefined) return MODEL_DOWNLOAD_INACTIVITY_TIMEOUT_MS;
	if (!Number.isFinite(value) || value <= 0) throw new Error("inactivityTimeoutMs must be a positive finite number");
	return Math.ceil(value);
}

function cancelDownloadReader(reader: ReadableStreamDefaultReader<Uint8Array> | undefined) {
	if (!reader) return;
	try {
		void reader.cancel().catch(ignoreDownloadFailure);
	} catch {
		// The original download failure remains authoritative.
	}
}

async function writeDownloadChunk(output: WriteStream, chunk: Buffer, outputFinished: Promise<void>) {
	if (output.destroyed) await outputFinished;
	if (output.write(chunk)) return;
	await Promise.race([once(output, "drain"), outputFinished]);
}

function ignoreDownloadFailure() {}

export function getWhisperCppModelNameFromPath(modelPath: string) {
	const match = /^ggml-(.+)\.(?:bin|gguf)$/i.exec(basename(modelPath));
	return match?.[1];
}

export function getDownloadableWhisperCppModelName(modelPath: string) {
	const match = /^ggml-(.+)\.bin$/i.exec(basename(modelPath));
	const modelName = match?.[1];
	return modelName && isKnownWhisperCppModelName(modelName) ? modelName : undefined;
}

export function isDownloadableWhisperCppModelPath(modelPath: string) {
	return getDownloadableWhisperCppModelName(modelPath) !== undefined;
}

export function isKnownWhisperCppModelName(modelName: string): modelName is (typeof WHISPER_CPP_MODEL_NAMES)[number] {
	return WHISPER_CPP_MODEL_NAMES.includes(modelName as (typeof WHISPER_CPP_MODEL_NAMES)[number]);
}

export function getWhisperCppModelUrl(modelName: string) {
	return `${WHISPER_CPP_MODEL_BASE_URL}/ggml-${modelName}.bin`;
}

export function getWhisperCppModelCacheDir() {
	return expandConfigPath(env("MICME_MODEL_DIR") || join(homedir(), ".cache", "whisper.cpp"));
}

export function getDefaultWhisperCppModelPath() {
	const rawModelName = env("MICME_DEFAULT_WHISPER_CPP_MODEL")?.trim() || DEFAULT_WHISPER_CPP_MODEL_NAME;
	const modelName = getTranslationAwareWhisperModelName(rawModelName);
	return join(getWhisperCppModelCacheDir(), `ggml-${modelName}.bin`);
}

export function formatDownloadProgress(downloadedBytes: number, totalBytes: number) {
	if (!totalBytes) return formatBytes(downloadedBytes);
	const percent = Math.max(0, Math.min(100, (downloadedBytes / totalBytes) * 100));
	return `${percent.toFixed(0)}% (${formatBytes(downloadedBytes)}/${formatBytes(totalBytes)})`;
}

export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = units[0];
	for (let index = 1; value >= 1024 && index < units.length; index++) {
		value /= 1024;
		unit = units[index];
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function safeBasename(path: string) {
	return sanitizeTerminalText(basename(path)) || "model";
}

function isRegularFile(path: string) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function assertDownloadTargetIsUsable(path: string, label: string) {
	try {
		if (statSync(path).isFile()) return;
	} catch (error) {
		if (isNotFoundError(error)) return;
		throw error;
	}
	throw new Error(`${label} exists but is not a file: ${path}`);
}

function isNotFoundError(error: unknown) {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
