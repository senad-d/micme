import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DotEnvState, TranscriptionMode } from "./types.ts";
import {
	DEFAULT_MACOS_PRINTABLE_SHORTCUT,
	DEFAULT_RECORD_SAMPLE_RATE,
	DEFAULT_SHORTCUT,
	DEFAULT_STREAM_KEEP_MS,
	DEFAULT_STREAM_LENGTH_MS,
	DEFAULT_STREAM_MAX_TOKENS,
	DEFAULT_STREAM_STEP_MS,
	DEFAULT_STREAM_VAD_THRESHOLD,
	DEFAULT_TRANSCRIBE_SAMPLE_RATE,
	DEFAULT_TRANSCRIBE_TIMEOUT_MS,
	DEFAULT_MIN_MAX_VOLUME_DB,
	STREAM_PROFILE_KEEP_MS,
	STREAM_PROFILE_LENGTH_MS,
	STREAM_PROFILE_MAX_TOKENS,
	STREAM_PROFILE_STEP_MS,
	STREAM_PROFILE_VAD_THRESHOLD,
	STREAM_PROFILE_WORDS_PER_CHUNK,
} from "./constants.ts";

let dotEnvState: DotEnvState = { path: "", values: {} };

export function reloadDotEnv(cwd: string) {
	dotEnvState = loadDotEnv(cwd);
	return dotEnvState;
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
			MICME_STREAM_KEEP_CONTEXT: "1",
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
		MICME_STREAM_KEEP_CONTEXT: "1",
		MICME_STREAM_FINALIZE_WITH_CLIP: "1",
		MICME_STREAM_VAD_THRESHOLD: String(DEFAULT_STREAM_VAD_THRESHOLD),
	};
}

export async function writeDotEnvValue(cwd: string, key: string, value: string) {
	const path = join(cwd, ".env");
	const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
	const matcher = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
	let found = false;
	const nextLines = lines.map((line) => {
		if (!matcher.test(line)) return line;
		found = true;
		return `${key}=${formatDotEnvValue(value)}`;
	});

	if (!found) {
		if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") nextLines.push("");
		nextLines.push(`${key}=${formatDotEnvValue(value)}`);
	}

	await writeFile(path, `${nextLines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
}

export function formatDotEnvValue(value: string) {
	if (value === "") return "";
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

export function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function expandConfigPath(value: string) {
	return expandEnvReferences(value, dotEnvState.values);
}

export function loadDotEnv(cwd: string): DotEnvState {
	const path = join(cwd, ".env");
	if (!existsSync(path)) return { path: "", values: {} };

	try {
		const values: Record<string, string> = {};
		const content = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
		for (const line of content.split(/\r?\n/)) {
			const parsed = parseDotEnvLine(line, values);
			if (!parsed) continue;
			values[parsed.key] = parsed.value;
		}
		return { path, values };
	} catch (error) {
		return { path, values: {}, error: error instanceof Error ? error.message : String(error) };
	}
}

export function parseDotEnvLine(line: string, previousValues: Record<string, string>) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;

	const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
	if (!match) return undefined;

	const key = match[1] ?? "";
	if (!key.startsWith("MICME_")) return undefined;

	let value = match[2] ?? "";
	if (value.startsWith('"') && value.endsWith('"')) {
		value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	} else if (value.startsWith("'") && value.endsWith("'")) {
		value = value.slice(1, -1);
	} else {
		value = value.replace(/\s+#.*$/, "").trim();
	}

	value = expandEnvReferences(value, previousValues);
	return { key, value };
}

export function expandEnvReferences(value: string, previousValues: Record<string, string>) {
	const withHome = value.startsWith("~/") && process.env.HOME ? `${process.env.HOME}${value.slice(1)}` : value;
	return withHome.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, bare: string | undefined) => {
		const key = braced ?? bare ?? "";
		return previousValues[key] ?? process.env[key] ?? "";
	});
}

export function env(name: string) {
	return process.env[name] ?? dotEnvState.values[name];
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
	return value === undefined ? true : /^(1|true|yes|on)$/i.test(value);
}

export function getStreamFinalizeWithClip() {
	const value = env("MICME_STREAM_FINALIZE_WITH_CLIP");
	return value === undefined ? true : /^(1|true|yes|on)$/i.test(value);
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
