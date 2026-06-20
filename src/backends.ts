import { existsSync } from "node:fs";
import type { TranscribeBackend, TranscriptionMode, ResolvedTranscriptionPlan, ResolvedWhisperCppModel } from "./types.ts";
import { DEFAULT_TRANSCRIBE_BACKEND } from "./constants.ts";
import { env, expandConfigPath, getTranscribeBackend, getTranslateToEnglishLanguage, isTranscribeBackend } from "./config.ts";
import { getPythonWhisperModelName, isEnglishOnlyWhisperModelName, isTranslationUnsupportedWhisperModelName, resolveWhisperCppModel } from "./models.ts";
import { findExecutable, isExecutableFile } from "./processes.ts";

export type ResolveTranscriptionPlanOptions = {
	requestedBackend?: TranscribeBackend | string;
	transcriptionMode?: TranscriptionMode;
	customCommand?: string | null;
	whisperCppBinary?: string | null;
	whisperCppBinaryError?: string;
	whisperStreamBinary?: string | null;
	whisperStreamBinaryError?: string;
	pythonWhisperBinary?: string | null;
	whisperCppModel?: ResolvedWhisperCppModel;
	pythonModelName?: string;
};

export function resolveTranscriptionPlan(options: ResolveTranscriptionPlanOptions = {}): ResolvedTranscriptionPlan {
	const warnings: string[] = [];
	const requestedBackend = parseRequestedBackend(options.requestedBackend, warnings);
	const transcriptionMode = options.transcriptionMode ?? "clip";
	const customCommand = getOptionValue(options, "customCommand", () => env("MICME_TRANSCRIBE_COMMAND")?.trim() || undefined);
	const whisperCppModel = options.whisperCppModel ?? resolveWhisperCppModel();
	const pythonModelName = options.pythonModelName ?? getPythonWhisperModelName();

	if (transcriptionMode === "stream") {
		return resolveStreamingPlan({
			requestedBackend,
			customCommand: customCommand ?? undefined,
			whisperCppModel,
			warnings,
			whisperStreamBinary: getExecutableOption(options, "whisperStreamBinary", "whisperStreamBinaryError", getWhisperStreamBinary),
		});
	}

	const whisperCppBinary = getExecutableOption(options, "whisperCppBinary", "whisperCppBinaryError", getWhisperCppBinary);
	const pythonWhisperBinary = getOptionValue(options, "pythonWhisperBinary", getPythonWhisperBinary);

	if (requestedBackend === "custom") {
		return customCommand
			? customPlan(requestedBackend, customCommand, "MICME_TRANSCRIBE_BACKEND=custom")
			: nonePlan(requestedBackend, "MICME_TRANSCRIBE_BACKEND=custom but MICME_TRANSCRIBE_COMMAND is not set.", warnings);
	}

	if (requestedBackend === "whisper.cpp") {
		return whisperCppBinary
			? whisperCppPlan(requestedBackend, whisperCppBinary, whisperCppModel, "MICME_TRANSCRIBE_BACKEND=whisper.cpp")
			: nonePlan(requestedBackend, "MICME_TRANSCRIBE_BACKEND=whisper.cpp but whisper.cpp was not found.", warnings);
	}

	if (requestedBackend === "python") {
		return pythonWhisperBinary
			? pythonPlan(requestedBackend, pythonWhisperBinary, pythonModelName, "MICME_TRANSCRIBE_BACKEND=python")
			: nonePlan(requestedBackend, "MICME_TRANSCRIBE_BACKEND=python but the `whisper` CLI was not found.", warnings);
	}

	if (customCommand) return customPlan(requestedBackend, customCommand, "auto selected custom command because MICME_TRANSCRIBE_COMMAND is configured");
	if (whisperCppBinary) return whisperCppPlan(requestedBackend, whisperCppBinary, whisperCppModel, "auto selected whisper.cpp because a whisper.cpp binary is available");
	if (pythonWhisperBinary) return pythonPlan(requestedBackend, pythonWhisperBinary, pythonModelName, "auto selected Python Whisper because whisper.cpp is unavailable");

	return nonePlan(
		requestedBackend,
		"No Micme transcription backend found. Install whisper-cpp, install openai-whisper, set MICME_TRANSCRIBE_COMMAND, or choose a backend in /micme conf.",
		warnings,
	);
}

export function getWhisperCppBinary() {
	const configured = env("MICME_WHISPER_CPP_BIN")?.trim();
	if (configured) return resolveExecutableConfig(configured, "MICME_WHISPER_CPP_BIN");
	return findExecutable(["whisper-cli", "whisper-cpp"]);
}

export function getWhisperStreamBinary() {
	const configured = env("MICME_WHISPER_STREAM_BIN")?.trim();
	if (configured) return resolveExecutableConfig(configured, "MICME_WHISPER_STREAM_BIN");
	return findExecutable(["whisper-stream"]);
}

export function getPythonWhisperBinary() {
	return findExecutable(["whisper"]);
}

export function resolveExecutableConfig(value: string, configName: string) {
	const expanded = expandConfigPath(value);
	if (/[/\\]/.test(expanded)) {
		if (!existsSync(expanded)) throw new Error(`${configName} is set but not found: ${expanded}`);
		if (!isExecutableFile(expanded)) throw new Error(`${configName} is set but is not an executable file: ${expanded}`);
		return expanded;
	}
	const executable = findExecutable([expanded]);
	if (!executable) throw new Error(`${configName} is set but not found on PATH: ${expanded}`);
	return executable;
}

export function formatTranscriptionPlan(plan: ResolvedTranscriptionPlan) {
	const lines = [`Requested backend: ${formatBackendLabel(plan.requestedBackend)}`, `Effective backend: ${formatEffectiveBackendLabel(plan.effectiveBackend)}`];
	if (plan.binary) lines.push(`Binary: ${plan.binary}`);
	if (plan.modelPath) lines.push(`Model: ${plan.modelPath}`);
	else if (plan.modelName) lines.push(`Model: ${plan.modelName}`);
	if (plan.modelSource) lines.push(`Source: ${plan.modelSource}`);
	for (const warning of plan.warnings) lines.push(`Warning: ${warning}`);
	lines.push(`Reason: ${plan.reason}`);
	return lines.join("\n");
}

export function formatBackendLabel(backend: TranscribeBackend) {
	switch (backend) {
		case "auto":
			return "Auto";
		case "whisper.cpp":
			return "whisper.cpp";
		case "python":
			return "Python Whisper";
		case "custom":
			return "Custom command";
	}
}

export function formatEffectiveBackendLabel(backend: ResolvedTranscriptionPlan["effectiveBackend"]) {
	switch (backend) {
		case "whisper.cpp":
			return "whisper.cpp";
		case "python":
			return "Python Whisper";
		case "custom":
			return "Custom command";
		case "none":
			return "none";
	}
}

function resolveStreamingPlan(options: {
	requestedBackend: TranscribeBackend;
	customCommand?: string;
	whisperCppModel: ResolvedWhisperCppModel;
	warnings: string[];
	whisperStreamBinary?: string;
}): ResolvedTranscriptionPlan {
	const { requestedBackend, whisperCppModel, warnings, whisperStreamBinary } = options;
	if (requestedBackend === "python") {
		return nonePlan(requestedBackend, "Streaming mode requires whisper.cpp; Python Whisper only supports clip transcription.", warnings);
	}
	if (requestedBackend === "custom") {
		return nonePlan(requestedBackend, "Streaming mode requires whisper.cpp; custom transcribe commands only support clip transcription.", warnings);
	}
	if (!whisperStreamBinary) {
		const reason = requestedBackend === "auto"
			? "MICME_TRANSCRIPTION_MODE=stream but whisper-stream was not found. Auto stream mode requires whisper.cpp/whisper-stream."
			: "MICME_TRANSCRIBE_BACKEND=whisper.cpp and MICME_TRANSCRIPTION_MODE=stream but whisper-stream was not found.";
		return nonePlan(requestedBackend, reason, warnings);
	}
	return whisperCppPlan(requestedBackend, whisperStreamBinary, whisperCppModel, "streaming selected whisper.cpp because whisper-stream is available");
}

function customPlan(requestedBackend: TranscribeBackend, command: string, reason: string): ResolvedTranscriptionPlan {
	return {
		requestedBackend,
		effectiveBackend: "custom",
		reason,
		command,
		modelName: "unknown",
		modelSource: "custom-command",
		warnings: [],
	};
}

function whisperCppPlan(requestedBackend: TranscribeBackend, binary: string, model: ResolvedWhisperCppModel, reason: string): ResolvedTranscriptionPlan {
	const warnings: string[] = [];
	if (model.source === "explicit-path" && !model.exists && !model.downloadable) {
		warnings.push(`MICME_WHISPER_CPP_MODEL is set but not found: ${model.path}`);
	} else if (!model.exists && !model.downloadable) {
		warnings.push(`Whisper.cpp model is missing and is not a standard downloadable model: ${model.path}`);
	}
	if (model.translationFallbackFrom && model.modelName) {
		warnings.push(`Translation to English uses ${model.modelName} instead of ${model.translationFallbackFrom} because the selected model does not support translation.`);
	}
	warnings.push(...getTranslationModelWarnings(model.modelName));
	return {
		requestedBackend,
		effectiveBackend: "whisper.cpp",
		reason,
		binary,
		modelName: model.modelName,
		modelPath: model.path,
		modelSource: model.source,
		modelDownloadable: model.downloadable,
		warnings,
	};
}

function pythonPlan(requestedBackend: TranscribeBackend, binary: string, modelName: string, reason: string): ResolvedTranscriptionPlan {
	return {
		requestedBackend,
		effectiveBackend: "python",
		reason,
		binary,
		modelName,
		modelSource: "python-name",
		warnings: getTranslationModelWarnings(modelName),
	};
}

function getTranslationModelWarnings(modelName: string | undefined) {
	if (!getTranslateToEnglishLanguage()) return [];
	if (isEnglishOnlyWhisperModelName(modelName)) return [`Translation to English requires a multilingual Whisper model; ${modelName} appears to be English-only.`];
	if (isTranslationUnsupportedWhisperModelName(modelName)) return [`Translation to English is not supported by ${modelName}; choose large-v3 or another multilingual translate-capable model.`];
	return [];
}

function nonePlan(requestedBackend: TranscribeBackend, reason: string, warnings: string[]): ResolvedTranscriptionPlan {
	return {
		requestedBackend,
		effectiveBackend: "none",
		reason,
		warnings: [...warnings],
	};
}

function parseRequestedBackend(value: TranscribeBackend | string | undefined, warnings: string[]) {
	const raw = value ?? env("MICME_TRANSCRIBE_BACKEND")?.trim();
	if (!raw) return getTranscribeBackend();
	if (isTranscribeBackend(raw)) return raw;
	warnings.push(`Invalid MICME_TRANSCRIBE_BACKEND=${raw}; using ${DEFAULT_TRANSCRIBE_BACKEND}.`);
	return DEFAULT_TRANSCRIBE_BACKEND;
}

function getOptionValue<K extends keyof ResolveTranscriptionPlanOptions>(
	options: ResolveTranscriptionPlanOptions,
	key: K,
	fallback: () => Extract<ResolveTranscriptionPlanOptions[K], string | null | undefined>,
) {
	if (Object.prototype.hasOwnProperty.call(options, key)) {
		const value = options[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}
	const value = fallback();
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getExecutableOption(
	options: ResolveTranscriptionPlanOptions,
	key: "whisperCppBinary" | "whisperStreamBinary",
	errorKey: "whisperCppBinaryError" | "whisperStreamBinaryError",
	fallback: () => string | undefined,
) {
	const error = options[errorKey];
	if (error) return undefined;
	if (Object.prototype.hasOwnProperty.call(options, key)) {
		const value = options[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}
	try {
		return fallback();
	} catch {
		return undefined;
	}
}
