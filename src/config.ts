import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MicmeConfigState, TranscribeBackend, TranscriptionMode } from "./types.ts";
import {
	DEFAULT_AUTO_DOWNLOAD_MODEL,
	DEFAULT_MACOS_PRINTABLE_SHORTCUT,
	DEFAULT_MIN_MAX_VOLUME_DB,
	DEFAULT_RECORD_SYNC,
	DEFAULT_SHORTCUT,
	DEFAULT_STREAM_CAPTURE,
	DEFAULT_STREAM_FLUSH_MS,
	DEFAULT_STREAM_KEEP_MS,
	DEFAULT_STREAM_LENGTH_MS,
	DEFAULT_STREAM_MAX_TOKENS,
	DEFAULT_STREAM_STEP_MS,
	DEFAULT_STREAM_VAD_THRESHOLD,
	DEFAULT_STREAM_WORDS_PER_CHUNK,
	DEFAULT_TRANSCRIBE_BACKEND,
	DEFAULT_TRANSCRIBE_SAMPLE_RATE,
	DEFAULT_TRANSCRIBE_TIMEOUT_MS,
	MAX_AUDIO_SAMPLE_RATE,
	MAX_STREAM_CAPTURE,
	MAX_STREAM_FLUSH_MS,
	MAX_STREAM_KEEP_MS,
	MAX_STREAM_LENGTH_MS,
	MAX_STREAM_MAX_TOKENS,
	MAX_STREAM_STEP_MS,
	MAX_STREAM_VAD_THRESHOLD,
	MAX_STREAM_WORDS_PER_CHUNK,
	MAX_TRANSCRIBE_TIMEOUT_MS,
	MIN_AUDIO_SAMPLE_RATE,
	MIN_STREAM_CAPTURE,
	MIN_STREAM_FLUSH_MS,
	MIN_STREAM_KEEP_MS,
	MIN_STREAM_LENGTH_MS,
	MIN_STREAM_MAX_TOKENS,
	MIN_STREAM_STEP_MS,
	MIN_STREAM_VAD_THRESHOLD,
	MIN_STREAM_WORDS_PER_CHUNK,
	MIN_TRANSCRIBE_TIMEOUT_MS,
	STREAM_PROFILE_FLUSH_MS,
	STREAM_PROFILE_KEEP_MS,
	STREAM_PROFILE_LENGTH_MS,
	STREAM_PROFILE_MAX_TOKENS,
	STREAM_PROFILE_STEP_MS,
	STREAM_PROFILE_VAD_THRESHOLD,
	STREAM_PROFILE_WORDS_PER_CHUNK,
} from "./constants.ts";

const MICME_CONFIG_FILE = "micme.json";
const MICME_SCHEMA_URL = "https://raw.githubusercontent.com/senad-d/micme/main/micme.schema.json";
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_RETRY_MS = 25;
const requireModule = createRequire(import.meta.url);

type JsonObject = Record<string, unknown>;
type NumericSettingBounds = { minimum: number; maximum: number };
type ConfigLockLease = { path: string; ownerPath: string; token: string };

export type MicmeConfigWriteOptions = {
	signal?: AbortSignal;
	lockTimeoutMs?: number;
	lockRetryMs?: number;
};

export const NUMERIC_CONFIG_BOUNDS = {
	MICME_TRANSCRIBE_TIMEOUT_MS: { minimum: MIN_TRANSCRIBE_TIMEOUT_MS, maximum: MAX_TRANSCRIBE_TIMEOUT_MS },
	MICME_STREAM_CAPTURE: { minimum: MIN_STREAM_CAPTURE, maximum: MAX_STREAM_CAPTURE },
	MICME_STREAM_STEP_MS: { minimum: MIN_STREAM_STEP_MS, maximum: MAX_STREAM_STEP_MS },
	MICME_STREAM_LENGTH_MS: { minimum: MIN_STREAM_LENGTH_MS, maximum: MAX_STREAM_LENGTH_MS },
	MICME_STREAM_KEEP_MS: { minimum: MIN_STREAM_KEEP_MS, maximum: MAX_STREAM_KEEP_MS },
	MICME_STREAM_MAX_TOKENS: { minimum: MIN_STREAM_MAX_TOKENS, maximum: MAX_STREAM_MAX_TOKENS },
	MICME_STREAM_FLUSH_MS: { minimum: MIN_STREAM_FLUSH_MS, maximum: MAX_STREAM_FLUSH_MS },
	MICME_STREAM_WORDS_PER_CHUNK: { minimum: MIN_STREAM_WORDS_PER_CHUNK, maximum: MAX_STREAM_WORDS_PER_CHUNK },
	MICME_STREAM_VAD_THRESHOLD: { minimum: MIN_STREAM_VAD_THRESHOLD, maximum: MAX_STREAM_VAD_THRESHOLD },
	MICME_RECORD_SAMPLE_RATE: { minimum: MIN_AUDIO_SAMPLE_RATE, maximum: MAX_AUDIO_SAMPLE_RATE },
	MICME_TRANSCRIBE_SAMPLE_RATE: { minimum: MIN_AUDIO_SAMPLE_RATE, maximum: MAX_AUDIO_SAMPLE_RATE },
	MICME_AVFOUNDATION_INPUT_SAMPLE_RATE: { minimum: MIN_AUDIO_SAMPLE_RATE, maximum: MAX_AUDIO_SAMPLE_RATE },
} as const satisfies Record<string, NumericSettingBounds>;

let piAgentDirChecked = false;
let piAgentDir: string | undefined;
let micmeConfigState: MicmeConfigState = loadMicmeJson();
const configWriteTails = new Map<string, Promise<void>>();

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

export function requireValidMicmeConfig() {
	const state = reloadMicmeConfig();
	if (!state.error) return state;
	throw new Error(`Micme config is invalid at ${state.path}: ${state.error}. Fix or remove it before using Micme operational commands.`);
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
	} catch {
		return { path, values: {}, error: "file is not valid JSON" };
	}
}

export async function writeMicmeConfigValue(key: string, value: string, options: MicmeConfigWriteOptions = {}) {
	await writeMicmeConfigValues({ [key]: value }, options);
}

export function writeMicmeConfigValues(values: Record<string, string | undefined>, options: MicmeConfigWriteOptions = {}) {
	for (const key of Object.keys(values)) {
		if (!key.startsWith("MICME_")) return Promise.reject(new Error(`Micme config keys must start with MICME_: ${key}`));
	}

	const configPath = getMicmeConfigPath();
	const previous = configWriteTails.get(configPath) ?? Promise.resolve();
	const writeOperation = commitMicmeConfigValues.bind(undefined, configPath, values, options);
	const pending = previous.catch(ignoreConfigWriteFailure).then(writeOperation);
	configWriteTails.set(configPath, pending);
	return pending.finally(removeConfigWriteTail.bind(undefined, configPath, pending));
}

async function commitMicmeConfigValues(configPath: string, values: Record<string, string | undefined>, options: MicmeConfigWriteOptions) {
	const configDir = dirname(configPath);
	await mkdir(configDir, { recursive: true });
	const lease = await acquireMicmeConfigLock(configPath, options);
	const tempPath = join(configDir, `.micme.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);

	try {
		options.signal?.throwIfAborted();
		const existing = readMicmeJsonObjectForWrite(configPath);
		const next = mergeMicmeConfigValues(existing, values);
		await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, signal: options.signal });
		options.signal?.throwIfAborted();
		await rename(tempPath, configPath);
		reloadMicmeConfig();
	} finally {
		await rm(tempPath, { force: true }).catch(ignoreConfigWriteFailure);
		await releaseMicmeConfigLock(lease);
	}
}

function mergeMicmeConfigValues(existing: JsonObject, values: Record<string, string | undefined>) {
	const next: JsonObject = { ...existing };
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) {
			delete next[key];
		} else {
			next[key] = String(value);
		}
	}
	return next;
}

async function acquireMicmeConfigLock(configPath: string, options: MicmeConfigWriteOptions): Promise<ConfigLockLease> {
	const lockPath = `${configPath}.lock`;
	const ownerPath = join(lockPath, "owner.json");
	const token = randomUUID();
	const timeoutMs = positiveDuration(options.lockTimeoutMs, CONFIG_LOCK_TIMEOUT_MS, "lockTimeoutMs");
	const retryMs = positiveDuration(options.lockRetryMs, CONFIG_LOCK_RETRY_MS, "lockRetryMs");
	const deadline = Date.now() + timeoutMs;

	while (true) {
		options.signal?.throwIfAborted();
		try {
			await mkdir(lockPath, { mode: 0o700 });
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				throw new Error(`Timed out waiting ${timeoutMs} ms for Micme config lock at ${lockPath}. The lock may be active or stale; Micme will not remove a lock owned by another writer.`, { cause: error });
			}
			await delay(Math.min(retryMs, remainingMs), undefined, { signal: options.signal });
			continue;
		}

		const lease = { path: lockPath, ownerPath, token };
		try {
			options.signal?.throwIfAborted();
			await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				signal: options.signal,
			});
			return lease;
		} catch (error) {
			await rm(lockPath, { recursive: true, force: true }).catch(ignoreConfigWriteFailure);
			throw error;
		}
	}
}

async function releaseMicmeConfigLock(lease: ConfigLockLease) {
	let owner: unknown;
	try {
		owner = JSON.parse(await readFile(lease.ownerPath, "utf8"));
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return;
		throw error;
	}
	if (!isJsonObject(owner) || owner.token !== lease.token) return;
	await rm(lease.path, { recursive: true, force: true });
}

function positiveDuration(value: number | undefined, fallback: number, name: string) {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
	return Math.ceil(value);
}

function isNodeError(error: unknown, code: string) {
	return error instanceof Error && "code" in error && error.code === code;
}

function ignoreConfigWriteFailure() {
	// Best-effort cleanup must not replace the config write failure already being handled.
}

function removeConfigWriteTail(configPath: string, pending: Promise<void>) {
	if (configWriteTails.get(configPath) === pending) configWriteTails.delete(configPath);
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
		MICME_STREAM_WORDS_PER_CHUNK: String(DEFAULT_STREAM_WORDS_PER_CHUNK),
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
	return withHome.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_match, braced: string | undefined, bare: string | undefined) => {
		const key = braced ?? bare ?? "";
		return process.env[key] ?? configValues[key] ?? "";
	});
}

export function env(name: string) {
	return process.env[name] ?? micmeConfigState.values[name];
}

export function getShortcutSettingValue() {
	const shortcut = env("MICME_SHORTCUT");
	if (shortcut !== undefined) return shortcut;

	const legacyPrintableShortcut = firstShortcutValue(env("MICME_PRINTABLE_SHORTCUTS"));
	return legacyPrintableShortcut || DEFAULT_SHORTCUT;
}

export function getShortcut() {
	return getShortcutSettingValue() || "not set";
}

export function getTerminalShortcut() {
	const shortcut = env("MICME_SHORTCUT");
	if (shortcut !== undefined) return isTerminalShortcut(shortcut) ? shortcut.trim() : undefined;
	return DEFAULT_SHORTCUT;
}

const TRANSCRIPTION_MODES = ["clip", "stream"] as const;
const TRANSCRIBE_BACKENDS = ["auto", "whisper.cpp", "python", "custom"] as const;

export function getTranscriptionMode() {
	return parseConfiguredChoice(env("MICME_TRANSCRIPTION_MODE"), TRANSCRIPTION_MODES, "clip");
}

export function getTranslateToEnglishLanguage() {
	const value = env("MICME_TRANSLATE_TO_ENGLISH")?.trim();
	if (!value || /^(0|false|no|off)$/i.test(value)) return undefined;
	return value;
}

export function getTranscribeBackend(): TranscribeBackend {
	return parseConfiguredChoice(env("MICME_TRANSCRIBE_BACKEND")?.trim(), TRANSCRIBE_BACKENDS, DEFAULT_TRANSCRIBE_BACKEND);
}

export function isTranscribeBackend(value: string | undefined): value is TranscribeBackend {
	return value !== undefined && TRANSCRIBE_BACKENDS.includes(value as TranscribeBackend);
}

function parseConfiguredChoice<T extends string>(value: string | undefined, choices: readonly T[], fallback: T) {
	return value !== undefined && choices.includes(value as T) ? (value as T) : fallback;
}

const NAMED_TERMINAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
]);
const FUNCTION_TERMINAL_KEY_PATTERN = /^f\d{1,2}$/i;
const MODIFIED_TERMINAL_KEY_PATTERN = /^(?:(?:ctrl|control|alt|option|meta|cmd|command|shift|super)\+)+.+$/i;

export function getPrintableShortcuts() {
	const shortcut = env("MICME_SHORTCUT");
	if (shortcut !== undefined) return getPrintableShortcutsForUnifiedShortcut(shortcut);

	const legacyConfigured = env("MICME_PRINTABLE_SHORTCUTS");
	if (legacyConfigured !== undefined) return splitShortcutValues(legacyConfigured);
	return process.platform === "darwin" ? [DEFAULT_MACOS_PRINTABLE_SHORTCUT] : [];
}

export function matchesPrintableMicmeShortcut(data: string) {
	return getPrintableShortcuts().includes(data);
}

export function isTerminalShortcut(value: string) {
	const normalized = value.trim();
	return isPrintableAsciiCharacter(normalized) || isNamedTerminalKey(normalized) || FUNCTION_TERMINAL_KEY_PATTERN.test(normalized) || MODIFIED_TERMINAL_KEY_PATTERN.test(normalized);
}

function getPrintableShortcutsForUnifiedShortcut(shortcut: string) {
	if (shortcut && isTerminalShortcut(shortcut)) return getConfiguredLegacyPrintableShortcuts();
	if (shortcut) return splitShortcutValues(shortcut);
	return getConfiguredLegacyPrintableShortcuts();
}

function getConfiguredLegacyPrintableShortcuts() {
	const legacyConfigured = env("MICME_PRINTABLE_SHORTCUTS");
	return legacyConfigured === undefined ? [] : splitShortcutValues(legacyConfigured);
}

function isPrintableAsciiCharacter(value: string) {
	const characters = Array.from(value);
	if (characters.length !== 1) return false;
	const codePoint = characters[0]?.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7E;
}

function isNamedTerminalKey(value: string) {
	return NAMED_TERMINAL_KEYS.has(value.toLowerCase());
}

function firstShortcutValue(value: string | undefined) {
	return splitShortcutValues(value ?? "")[0] ?? "";
}

function splitShortcutValues(value: string) {
	return value
		.split(",")
		.map((candidate) => candidate.trim())
		.filter(Boolean);
}

export function getTranscribeTimeoutMs() {
	return parseBoundedInteger(env("MICME_TRANSCRIBE_TIMEOUT_MS"), NUMERIC_CONFIG_BOUNDS.MICME_TRANSCRIBE_TIMEOUT_MS) ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS;
}

export function getStreamCapture() {
	return parseBoundedInteger(env("MICME_STREAM_CAPTURE"), NUMERIC_CONFIG_BOUNDS.MICME_STREAM_CAPTURE) ?? DEFAULT_STREAM_CAPTURE;
}

export function getStreamStepMs() {
	return parseBoundedInteger(env("MICME_STREAM_STEP_MS"), NUMERIC_CONFIG_BOUNDS.MICME_STREAM_STEP_MS) ?? DEFAULT_STREAM_STEP_MS;
}

export function getStreamLengthMs() {
	return parseBoundedInteger(env("MICME_STREAM_LENGTH_MS"), NUMERIC_CONFIG_BOUNDS.MICME_STREAM_LENGTH_MS) ?? DEFAULT_STREAM_LENGTH_MS;
}

export function getStreamKeepMs() {
	return parseBoundedInteger(env("MICME_STREAM_KEEP_MS"), NUMERIC_CONFIG_BOUNDS.MICME_STREAM_KEEP_MS) ?? DEFAULT_STREAM_KEEP_MS;
}

export function getStreamMaxTokens() {
	return parseBoundedInteger(env("MICME_STREAM_MAX_TOKENS"), NUMERIC_CONFIG_BOUNDS.MICME_STREAM_MAX_TOKENS) ?? DEFAULT_STREAM_MAX_TOKENS;
}

export function getStreamVadThreshold() {
	return parseBoundedNumber(env("MICME_STREAM_VAD_THRESHOLD"), NUMERIC_CONFIG_BOUNDS.MICME_STREAM_VAD_THRESHOLD) ?? DEFAULT_STREAM_VAD_THRESHOLD;
}

export function getStreamKeepContext() {
	return getFlagSetting("MICME_STREAM_KEEP_CONTEXT", false);
}

export function getStreamFlushMs() {
	return parseBoundedInteger(env("MICME_STREAM_FLUSH_MS"), NUMERIC_CONFIG_BOUNDS.MICME_STREAM_FLUSH_MS) ?? DEFAULT_STREAM_FLUSH_MS;
}

export function getStreamFinalizeWithClip() {
	return getFlagSetting("MICME_STREAM_FINALIZE_WITH_CLIP", false);
}

export function getStreamWordsPerChunk() {
	return parseBoundedInteger(env("MICME_STREAM_WORDS_PER_CHUNK"), NUMERIC_CONFIG_BOUNDS.MICME_STREAM_WORDS_PER_CHUNK) ?? DEFAULT_STREAM_WORDS_PER_CHUNK;
}

export function getRecordSampleRate() {
	const configured = env("MICME_RECORD_SAMPLE_RATE")?.trim();
	if (!configured || /^auto$/i.test(configured)) return undefined;
	return parseBoundedInteger(configured, NUMERIC_CONFIG_BOUNDS.MICME_RECORD_SAMPLE_RATE);
}

export function getTranscribeSampleRate() {
	return parseBoundedInteger(env("MICME_TRANSCRIBE_SAMPLE_RATE"), NUMERIC_CONFIG_BOUNDS.MICME_TRANSCRIBE_SAMPLE_RATE) ?? DEFAULT_TRANSCRIBE_SAMPLE_RATE;
}

export function getAutoDownloadModel() {
	return getFlagSetting("MICME_AUTO_DOWNLOAD_MODEL", DEFAULT_AUTO_DOWNLOAD_MODEL);
}

export function getRecordMeter() {
	return envFlag("MICME_RECORD_METER");
}

export function getRecordSync() {
	return getFlagSetting("MICME_RECORD_SYNC", DEFAULT_RECORD_SYNC);
}

export function getAvfoundationDropLateFrames() {
	return envFlag("MICME_AVFOUNDATION_DROP_LATE_FRAMES");
}

export function getAvfoundationInputSampleRate() {
	return parseBoundedInteger(env("MICME_AVFOUNDATION_INPUT_SAMPLE_RATE"), NUMERIC_CONFIG_BOUNDS.MICME_AVFOUNDATION_INPUT_SAMPLE_RATE);
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
	return getFlagSetting(name, false);
}

function getFlagSetting(name: string, fallback: boolean) {
	const value = env(name)?.trim();
	if (/^(1|true|yes|on)$/i.test(value ?? "")) return true;
	if (/^(0|false|no|off)$/i.test(value ?? "")) return false;
	return fallback;
}

function parseBoundedInteger(value: string | undefined, bounds: NumericSettingBounds) {
	const number = parseFiniteNumber(value);
	if (number === undefined) return undefined;
	const normalized = Math.round(number);
	return normalized >= bounds.minimum && normalized <= bounds.maximum ? normalized : undefined;
}

function parseBoundedNumber(value: string | undefined, bounds: NumericSettingBounds) {
	const number = parseFiniteNumber(value);
	return number !== undefined && number >= bounds.minimum && number <= bounds.maximum ? number : undefined;
}

function parseFiniteNumber(value: string | undefined) {
	if (!value?.trim()) return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function readMicmeJsonObjectForWrite(configPath: string): JsonObject {
	if (!existsSync(configPath)) return { $schema: MICME_SCHEMA_URL };

	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
		if (!isJsonObject(parsed)) throw new Error("top-level value must be a JSON object");
		return parsed;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot save Micme config: ${configPath} is invalid JSON (${message}). Fix or remove it first.`, { cause: error });
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
