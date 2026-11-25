import { existsSync } from "node:fs";
import type { TranscribeBackend, TranscriptionMode, ResolvedTranscriptionPlan, ResolvedWhisperCppModel } from "./types.ts";
import { DEFAULT_TRANSCRIBE_BACKEND } from "./constants.ts";
import { env, expandConfigPath, getTranscribeBackend, getTranslateToEnglishLanguage, isTranscribeBackend } from "./config.ts";
import { getPythonWhisperModelName, isEnglishOnlyWhisperModelName, isTranslationUnsupportedWhisperModelName, resolveWhisperCppModel } from "./models.ts";
import { resolveLivePlanDetails } from "./live-plan.ts";
import { findExecutable, isExecutableFile } from "./processes.ts";

export type RequestedTranscribeBackend = TranscribeBackend | (string & Record<never, never>);

export type ResolveTranscriptionPlanOptions = {
	requestedBackend?: RequestedTranscribeBackend;
	transcriptionMode?: TranscriptionMode;
	customCommand?: string | null;
	whisperCppBinary?: string | null;
	whisperCppBinaryError?: string;
	pythonWhisperBinary?: string | null;
	whisperCppModel?: ResolvedWhisperCppModel;
	pythonModelName?: string;
};

export function resolveTranscriptionPlan(options: ResolveTranscriptionPlanOptions = {}): ResolvedTranscriptionPlan {
	if (options.transcriptionMode === "stream") return projectLivePlan(options.requestedBackend);
	const warnings: string[] = [];
	const requestedBackend = parseRequestedBackend(options.requestedBackend, warnings);

	const customCommand = getOptionValue(options, "customCommand", () => env("MICME_TRANSCRIBE_COMMAND")?.trim() || undefined);
	const whisperCppModel = options.whisperCppModel ?? resolveWhisperCppModel();
	const pythonModelName = options.pythonModelName ?? getPythonWhisperModelName();
	const whisperCppBinary = getWhisperCppBinaryOption(options, warnings);
	const pythonWhisperBinary = getOptionValue(options, "pythonWhisperBinary", getPythonWhisperBinary);

	if (requestedBackend === "custom") {
		return customCommand
			? customPlan(requestedBackend, customCommand, "MICME_TRANSCRIBE_BACKEND=custom", warnings)
			: nonePlan(requestedBackend, "MICME_TRANSCRIBE_BACKEND=custom but MICME_TRANSCRIBE_COMMAND is not set.", warnings);
	}

	if (requestedBackend === "whisper.cpp") {
		return whisperCppBinary
			? whisperCppPlan(requestedBackend, whisperCppBinary, whisperCppModel, "MICME_TRANSCRIBE_BACKEND=whisper.cpp", warnings)
			: nonePlan(requestedBackend, "MICME_TRANSCRIBE_BACKEND=whisper.cpp but whisper.cpp was not found.", warnings);
	}

	if (requestedBackend === "python") {
		return pythonWhisperBinary
			? pythonPlan(requestedBackend, pythonWhisperBinary, pythonModelName, "MICME_TRANSCRIBE_BACKEND=python", warnings)
			: nonePlan(requestedBackend, "MICME_TRANSCRIBE_BACKEND=python but the `whisper` CLI was not found.", warnings);
	}

	if (customCommand) return customPlan(requestedBackend, customCommand, "auto selected custom command because MICME_TRANSCRIBE_COMMAND is configured", warnings);
	if (whisperCppBinary) return whisperCppPlan(requestedBackend, whisperCppBinary, whisperCppModel, "auto selected whisper.cpp because a whisper.cpp binary is available", warnings);
	if (pythonWhisperBinary) return pythonPlan(requestedBackend, pythonWhisperBinary, pythonModelName, "auto selected Python Whisper because whisper.cpp is unavailable", warnings);

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

export function getPythonWhisperBinary() {
	return findExecutable(["whisper"]);
}

export function resolveExecutableConfig(value: string, configName: string, recovery = "") {
	const expanded = expandConfigPath(value);
	if (/[/\\]/.test(expanded)) {
		if (!existsSync(expanded)) throw new Error(`${configName} is set but not found: ${expanded}${recovery}`);
		if (!isExecutableFile(expanded)) throw new Error(`${configName} is set but is not an executable file: ${expanded}${recovery}`);
		return expanded;
	}
	const executable = findExecutable([expanded]);
	if (!executable) throw new Error(`${configName} is set but not found on PATH: ${expanded}${recovery}`);
	return executable;
}

export function formatTranscriptionPlan(plan: ResolvedTranscriptionPlan) {
	const lines = [`Requested backend: ${formatBackendLabel(plan.requestedBackend)}`, `Effective backend: ${formatEffectiveBackendLabel(plan.effectiveBackend)}`];
	if (plan.binary) lines.push(`Binary: ${plan.binary}`);
	if (plan.modelPath) lines.push(`Model: ${plan.modelPath}`);
	else if (plan.modelName) lines.push(`Model: ${plan.modelName}`);
	if (plan.modelSource) lines.push(`Source: ${plan.modelSource}`);
	if (plan.live) {
		lines.push(`VAD model: ${plan.live.vadModelPath}`);
		lines.push(`Language: ${plan.live.language}${plan.live.translate ? " (translate to English)" : ""}`);
	}
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

function projectLivePlan(override: RequestedTranscribeBackend | undefined): ResolvedTranscriptionPlan {
	const warnings: string[] = [];
	const requestedBackend = override === undefined ? getTranscribeBackend() : parseRequestedBackend(override, warnings);
	try {
		const { live, model } = resolveLivePlanDetails(override === undefined ? undefined : requestedBackend);
		const plan = whisperCppPlan(requestedBackend, live.binary, model, "selected micme-live for stream mode", warnings);
		return { ...plan, modelPath: live.modelPath, live };
	} catch (error) {
		return nonePlan(requestedBackend, error instanceof Error ? error.message : String(error), warnings);
	}
}

function customPlan(requestedBackend: TranscribeBackend, command: string, reason: string, inheritedWarnings: string[] = []): ResolvedTranscriptionPlan {
	return {
		requestedBackend,
		effectiveBackend: "custom",
		reason,
		command,
		modelName: "unknown",
		modelSource: "custom-command",
		warnings: [...inheritedWarnings],
	};
}

function whisperCppPlan(requestedBackend: TranscribeBackend, binary: string, model: ResolvedWhisperCppModel, reason: string, inheritedWarnings: string[] = []): ResolvedTranscriptionPlan {
	const warnings: string[] = [...inheritedWarnings];
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

function pythonPlan(requestedBackend: TranscribeBackend, binary: string, modelName: string, reason: string, inheritedWarnings: string[] = []): ResolvedTranscriptionPlan {
	return {
		requestedBackend,
		effectiveBackend: "python",
		reason,
		binary,
		modelName,
		modelSource: "python-name",
		warnings: [...inheritedWarnings, ...getTranslationModelWarnings(modelName)],
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

function parseRequestedBackend(value: RequestedTranscribeBackend | undefined, warnings: string[]) {
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
	if (Object.hasOwn(options, key)) {
		const value = options[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}
	const value = fallback();
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getWhisperCppBinaryOption(options: ResolveTranscriptionPlanOptions, warnings: string[]) {
	if (options.whisperCppBinaryError) {
		warnings.push(options.whisperCppBinaryError);
		return undefined;
	}
	try {
		return getOptionValue(options, "whisperCppBinary", getWhisperCppBinary);
	} catch (error) {
		warnings.push(error instanceof Error ? error.message : String(error));
		return undefined;
	}
}
