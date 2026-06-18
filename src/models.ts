import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { once } from "node:events";
import { createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import {
	DEFAULT_WHISPER_CPP_MODEL_NAME,
	STATUS_KEY,
	WHISPER_CPP_MODEL_BASE_URL,
	WHISPER_CPP_MODEL_NAMES,
} from "./constants.ts";
import { env, expandConfigPath } from "./config.ts";
import type { ModelCandidate } from "./types.ts";

const modelDownloads = new Map<string, Promise<void>>();

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
		add({
			label: basename(expanded),
			value: expanded,
			description: existsSync(expanded) ? `current model: ${expanded}` : `current model path is missing: ${expanded}`,
			installed: existsSync(expanded),
		});
	}

	for (const file of scanModelFiles(cwd)) {
		add({ label: basename(file), value: file, description: file, installed: true });
	}

	const cacheDir = getWhisperCppModelCacheDir();
	for (const modelName of WHISPER_CPP_MODEL_NAMES) {
		const path = join(cacheDir, `ggml-${modelName}.bin`);
		add({
			label: `ggml-${modelName}.bin`,
			value: path,
			description: `${describeWhisperModel(modelName)}${existsSync(path) ? "" : " (expected path; download model first)"}`,
			installed: existsSync(path),
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

export async function ensureWhisperCppModel(modelPath: string, ctx?: ExtensionContext) {
	if (existsSync(modelPath)) return;
	if (env("MICME_AUTO_DOWNLOAD_MODEL") === "0") {
		throw new Error(`Micme model is missing and auto-download is disabled: ${modelPath}`);
	}

	const existingDownload = modelDownloads.get(modelPath);
	if (existingDownload) {
		ctx?.ui.setStatus(STATUS_KEY, `waiting for ${basename(modelPath)} download…`);
		try {
			await existingDownload;
		} finally {
			ctx?.ui.setStatus(STATUS_KEY, undefined);
		}
		return;
	}

	const modelName = getWhisperCppModelNameFromPath(modelPath);
	if (!modelName) {
		throw new Error(`Micme model is missing and cannot infer download URL: ${modelPath}`);
	}

	const download = downloadWhisperCppModel(modelName, modelPath, ctx);
	modelDownloads.set(modelPath, download);
	try {
		await download;
	} finally {
		modelDownloads.delete(modelPath);
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	}
}

export async function downloadWhisperCppModel(modelName: string, modelPath: string, ctx?: ExtensionContext) {
	if (existsSync(modelPath)) return;
	const url = getWhisperCppModelUrl(modelName);
	ctx?.ui.setStatus(STATUS_KEY, `downloading ${basename(modelPath)}…`);
	ctx?.ui.notify(`Downloading ${basename(modelPath)}. This can take a while the first time.`, "info");
	await downloadFile(url, modelPath, ctx);
	ctx?.ui.notify(`Downloaded ${basename(modelPath)}.`, "info");
}

export async function downloadFile(url: string, targetPath: string, ctx?: ExtensionContext) {
	if (existsSync(targetPath)) return;
	await mkdir(dirname(targetPath), { recursive: true });
	const tempPath = `${targetPath}.download-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
	}

	const totalBytes = Number(response.headers.get("content-length") || "0");
	const reader = response.body.getReader();
	const output = createWriteStream(tempPath, { flags: "wx" });
	let downloadedBytes = 0;
	let lastUpdate = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			downloadedBytes += value.byteLength;
			if (!output.write(Buffer.from(value))) {
				await once(output, "drain");
			}

			const now = Date.now();
			if (ctx && now - lastUpdate > 1_000) {
				ctx.ui.setStatus(STATUS_KEY, `downloading ${basename(targetPath)} ${formatDownloadProgress(downloadedBytes, totalBytes)}`);
				lastUpdate = now;
			}
		}

		output.end();
		await finished(output);
		if (existsSync(targetPath)) {
			await unlink(tempPath).catch(() => undefined);
			return;
		}
		await rename(tempPath, targetPath);
	} catch (error) {
		output.destroy();
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

export function getWhisperCppModelNameFromPath(modelPath: string) {
	const match = basename(modelPath).match(/^ggml-(.+)\.(?:bin|gguf)$/i);
	return match?.[1];
}

export function getWhisperCppModelUrl(modelName: string) {
	return `${WHISPER_CPP_MODEL_BASE_URL}/ggml-${modelName}.bin`;
}

export function getWhisperCppModelCacheDir() {
	return expandConfigPath(env("MICME_MODEL_DIR") || join(homedir(), ".cache", "whisper.cpp"));
}

export function getDefaultWhisperCppModelPath() {
	const modelName = env("MICME_DEFAULT_WHISPER_CPP_MODEL") || DEFAULT_WHISPER_CPP_MODEL_NAME;
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
