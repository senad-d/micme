import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MicmeConfigState, TranscriptionMode } from "./types.ts";
import {
	DEFAULT_MACOS_PRINTABLE_SHORTCUT,
	DEFAULT_RECORD_SAMPLE_RATE,
	DEFAULT_SHORTCUT,
	DEFAULT_STREAM_KEEP_MS,
	DEFAULT_STREAM_LENGTH_MS,
	DEFAULT_STREAM_MAX_TOKENS,
	DEFAULT_STREAM_STEP_MS,
	DEFAULT_STREAM_VAD_THRESHOLD,
	DEFAULT_STREAM_FLUSH_MS,
	DEFAULT_TRANSCRIBE_SAMPLE_RATE,
	DEFAULT_TRANSCRIBE_TIMEOUT_MS,
	DEFAULT_MIN_MAX_VOLUME_DB,
	STREAM_PROFILE_KEEP_MS,
	STREAM_PROFILE_LENGTH_MS,
	STREAM_PROFILE_MAX_TOKENS,
	STREAM_PROFILE_STEP_MS,
	STREAM_PROFILE_VAD_THRESHOLD,
	STREAM_PROFILE_WORDS_PER_CHUNK,
	STREAM_PROFILE_FLUSH_MS,
} from "./constants.ts";

const MICME_CONFIG_FILE = "micme.json";
const MICME_SCHEMA_URL = "https://raw.githubusercontent.com/senad-d/micme/main/micme.schema.json";
const requireModule = createRequire(import.meta.url);

type JsonObject = Record<string, unknown>;

let piAgentDirChecked = false;
let piAgentDir: string | undefined;
let micmeConfigState: MicmeConfigState = loadMicmeJson();

export function getMicmeAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return resolve(configured);

	const exported = getPiExportedAgentDir();
	if (exported) return resolve(exported);

	return join(homedir(), ".pi", "agent");
}

export function getMicmeConfigPath() {
	return join(getMicmeAgentDir(), MICME_CONFIG_FILE);
}

export function reloadMicmeConfig() {
	micmeConfigState = loadMicmeJson();
	return micmeConfigState;
}

export function loadMicmeJson(): MicmeConfigState {
	const path = getMicmeConfigPath();
	if (!existsSync(path)) return { path, values: {} };

	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
		if (!isJsonObject(parsed)) {
			return { path, values: {}, error: "top-level value must be a JSON object" };
		}
		return { path, values: extractMicmeValues(parsed) };
	} catch (error) {
		return { path, values: {}, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function writeMicmeConfigValue(key: string, value: string) {
	await writeMicmeConfigValues({ [key]: value });
}

export async function writeMicmeConfigValues(values: Record<string, string>) {
	for (const key of Object.keys(values)) {
		if (!key.startsWith("MICME_")) throw new Error(`Micme config keys must start with MICME_: ${key}`);
	}

	const configPath = getMicmeConfigPath();
	const configDir = dirname(configPath);
	const existing = readMicmeJsonObjectForWrite(configPath);
	const next: JsonObject = { ...existing };

	for (const [key, value] of Object.entries(values)) next[key] = String(value);

	await mkdir(configDir, { recursive: true });
	const tempPath = join(configDir, `.micme.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	try {
		await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, configPath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}

	reloadMicmeConfig();
}

export function getTranscriptionModeProfile(mode: TranscriptionMode): Record<string, string> {
	if (mode === "stream") {
		return {
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_STREAM_STEP_MS: String(STREAM_PROFILE_STEP_MS),
			MICME_STREAM_LENGTH_MS: String(STREAM_PROFILE_LENGTH_MS),
			MICME_STREAM_KEEP_MS: String(STREAM_PROFILE_KEEP_MS),
			MICME_STREAM_MAX_TOKENS: String(STREAM_PROFILE_MAX_TOKENS),
			MICME_STREAM_WORDS_PER_CHUNK: String(STREAM_PROFILE_WORDS_PER_CHUNK),
			MICME_STREAM_FLUSH_MS: String(STREAM_PROFILE_FLUSH_MS),
			// whisper-stream's upstream default is no prompt carry-over. Keep it disabled for Micme's append-only stream profile so raw dictation is less likely to rewrite short chunks contextually.
			MICME_STREAM_KEEP_CONTEXT: "0",
			MICME_STREAM_FINALIZE_WITH_CLIP: "0",
			MICME_STREAM_VAD_THRESHOLD: String(STREAM_PROFILE_VAD_THRESHOLD),
		};
	}

	return {
		MICME_TRANSCRIPTION_MODE: "clip",
		MICME_STREAM_STEP_MS: String(DEFAULT_STREAM_STEP_MS),
		MICME_STREAM_LENGTH_MS: String(DEFAULT_STREAM_LENGTH_MS),
		MICME_STREAM_KEEP_MS: String(DEFAULT_STREAM_KEEP_MS),
		MICME_STREAM_MAX_TOKENS: String(DEFAULT_STREAM_MAX_TOKENS),
		MICME_STREAM_WORDS_PER_CHUNK: "10",
		MICME_STREAM_FLUSH_MS: String(DEFAULT_STREAM_FLUSH_MS),
		MICME_STREAM_KEEP_CONTEXT: "0",
		MICME_STREAM_FINALIZE_WITH_CLIP: "1",
		MICME_STREAM_VAD_THRESHOLD: String(DEFAULT_STREAM_VAD_THRESHOLD),
	};
}

export function expandConfigPath(value: string) {
	return expandEnvReferences(value, micmeConfigState.values);
}

export function expandEnvReferences(value: string, configValues: Record<string, string>) {
	const withHome = value.startsWith("~/") && process.env.HOME ? `${process.env.HOME}${value.slice(1)}` : value;
	return withHome.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, bare: string | undefined) => {
		const key = braced ?? bare ?? "";
		return process.env[key] ?? configValues[key] ?? "";
	});
}

export function env(name: string) {
	return process.env[name] ?? micmeConfigState.values[name];
}

export function getShortcut() {
	return env("MICME_SHORTCUT") || DEFAULT_SHORTCUT;
}

export function getTranscriptionMode() {
	return env("MICME_TRANSCRIPTION_MODE") === "stream" ? "stream" : "clip";
}

export function getPrintableShortcuts() {
	const configured = env("MICME_PRINTABLE_SHORTCUTS");
	if (configured !== undefined) {
		return configured
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
	}
	return process.platform === "darwin" ? [DEFAULT_MACOS_PRINTABLE_SHORTCUT] : [];
}

export function matchesPrintableMicmeShortcut(data: string) {
	return getPrintableShortcuts().includes(data);
}

export function getTranscribeTimeoutMs() {
	const value = Number(env("MICME_TRANSCRIBE_TIMEOUT_MS"));
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TRANSCRIBE_TIMEOUT_MS;
}

export function getStreamStepMs() {
	const value = Number(env("MICME_STREAM_STEP_MS"));
	return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_STREAM_STEP_MS;
}

export function getStreamLengthMs() {
	const value = Number(env("MICME_STREAM_LENGTH_MS"));
	return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_STREAM_LENGTH_MS;
}

export function getStreamKeepMs() {
	const value = Number(env("MICME_STREAM_KEEP_MS"));
	return Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_STREAM_KEEP_MS;
}

export function getStreamMaxTokens() {
	const value = Number(env("MICME_STREAM_MAX_TOKENS"));
	return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_STREAM_MAX_TOKENS;
}

export function getStreamVadThreshold() {
	const value = Number(env("MICME_STREAM_VAD_THRESHOLD"));
	return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_STREAM_VAD_THRESHOLD;
}

export function getStreamKeepContext() {
	const value = env("MICME_STREAM_KEEP_CONTEXT");
	return value === undefined ? false : /^(1|true|yes|on)$/i.test(value);
}

export function getStreamFlushMs() {
	const value = Number(env("MICME_STREAM_FLUSH_MS"));
	return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_STREAM_FLUSH_MS;
}

export function getStreamFinalizeWithClip() {
	const value = env("MICME_STREAM_FINALIZE_WITH_CLIP");
	return value === undefined ? false : /^(1|true|yes|on)$/i.test(value);
}

export function getStreamWordsPerChunk() {
	const value = Number(env("MICME_STREAM_WORDS_PER_CHUNK"));
	return Number.isFinite(value) && value > 0 ? Math.min(10, Math.round(value)) : 10;
}

export function getRecordSampleRate() {
	const value = Number(env("MICME_RECORD_SAMPLE_RATE"));
	return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_RECORD_SAMPLE_RATE;
}

export function getTranscribeSampleRate() {
	const value = Number(env("MICME_TRANSCRIBE_SAMPLE_RATE"));
	return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_TRANSCRIBE_SAMPLE_RATE;
}

export function getAudioFilter() {
	if (env("MICME_AUDIO_FILTER") !== undefined) return env("MICME_AUDIO_FILTER")!.trim();
	return "highpass=f=80,lowpass=f=7600";
}

export function getMinMaxVolumeDb() {
	const value = Number(env("MICME_MIN_MAX_VOLUME_DB"));
	return Number.isFinite(value) ? value : DEFAULT_MIN_MAX_VOLUME_DB;
}

export function getMeterFloorDb() {
	const value = Number(env("MICME_METER_FLOOR_DB"));
	return Number.isFinite(value) ? value : 55;
}

export function getMeterPeakFloorDb() {
	const value = Number(env("MICME_METER_PEAK_FLOOR_DB"));
	return Number.isFinite(value) ? value : 45;
}

export function getMeterRangeDb() {
	const value = Number(env("MICME_METER_RANGE_DB"));
	return Number.isFinite(value) && value > 0 ? value : 35;
}

export function getMeterGain() {
	const value = Number(env("MICME_METER_GAIN"));
	return Number.isFinite(value) && value > 0 ? value : 1;
}

export function envFlag(name: string) {
	return /^(1|true|yes|on)$/i.test(env(name) || "");
}

function readMicmeJsonObjectForWrite(configPath: string): JsonObject {
	if (!existsSync(configPath)) return { $schema: MICME_SCHEMA_URL };

	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
		if (!isJsonObject(parsed)) throw new Error("top-level value must be a JSON object");
		return parsed;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot save Micme config: ${configPath} is invalid JSON (${message}). Fix or remove it first.`);
	}
}

function extractMicmeValues(json: JsonObject) {
	const values: Record<string, string> = {};
	for (const [key, value] of Object.entries(json)) {
		if (!key.startsWith("MICME_")) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") values[key] = String(value);
	}
	return values;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPiExportedAgentDir() {
	if (piAgentDirChecked) return piAgentDir;
	piAgentDirChecked = true;

	try {
		const piModule = requireModule("@earendil-works/pi-coding-agent") as { getAgentDir?: unknown };
		if (typeof piModule.getAgentDir === "function") {
			const value = piModule.getAgentDir();
			if (typeof value === "string" && value.trim()) piAgentDir = value;
		}
	} catch {
		// Some pi runtimes may not expose this helper or may be ESM-only. Falling back is safe.
	}

	return piAgentDir;
}
