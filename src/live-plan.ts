import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveExecutableConfig } from "./backends.ts";
import { env, getStreamFinalizeWithClip, getTranslateToEnglishLanguage } from "./config.ts";
import { DEFAULT_TRANSCRIBE_BACKEND } from "./constants.ts";
import { ensureWhisperCppModel, ensureWhisperVadModel, getWhisperVadModelPath, isEnglishOnlyWhisperModelName, isTranslationUnsupportedWhisperModelName, resolveWhisperCppModel } from "./models.ts";
import { findExecutable } from "./processes.ts";

export function resolveLivePlan() {
	const backend = env("MICME_TRANSCRIBE_BACKEND")?.trim() || DEFAULT_TRANSCRIBE_BACKEND;
	if (backend !== "auto" && backend !== "whisper.cpp") {
		throw new Error(`Live streaming requires MICME_TRANSCRIBE_BACKEND=auto or whisper.cpp (not ${backend}). Choose clip mode to use another backend.`);
	}

	const binary = resolveLiveBinary();
	const model = resolveWhisperCppModel({ preserveExplicitPath: true });
	const translationSource = getTranslateToEnglishLanguage();
	const translate = translationSource !== undefined;
	const language = (translationSource ?? env("MICME_LANGUAGE")?.trim() ?? "").toLowerCase() || "en";
	return {
		binary,
		modelPath: resolve(model.path),
		vadModelPath: getWhisperVadModelPath(),
		language: resolveLiveLanguage(language, translate, model.modelName),
		translate,
		finalizeWithClip: getStreamFinalizeWithClip(),
	};
}

export async function ensureLiveModels(plan: ReturnType<typeof resolveLivePlan>, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
	await ensureWhisperVadModel(plan.vadModelPath, ctx, { signal });
	await ensureWhisperCppModel(plan.modelPath, ctx, { signal });
}

function resolveLiveBinary() {
	const configured = env("MICME_LIVE_BIN")?.trim();
	const binary = configured ? resolveExecutableConfig(configured, "MICME_LIVE_BIN") : findExecutable([process.platform === "win32" ? "micme-live.exe" : "micme-live"]);
	if (!binary) throw new Error("micme-live was not found on PATH. Build and install it (native/live/README.md), set MICME_LIVE_BIN, or choose clip mode.");
	const path = resolve(binary);
	if (isLegacySdlExecutable(path) || isLegacySdlExecutable(realpathSync(path))) {
		throw new Error("whisper-stream is the legacy SDL executable, not the live worker. Install micme-live and point MICME_LIVE_BIN to it.");
	}
	return path;
}

function isLegacySdlExecutable(path: string) {
	return /^whisper-stream(?:\.exe)?$/i.test(basename(path));
}

function resolveLiveLanguage(language: string, translate: boolean, modelName: string | undefined) {
	// The quantized English-only distributions carry the language marker before the quantization suffix.
	const baseModelName = modelName?.replace(/-q\d+_\d+$/i, "");
	const englishOnly = isEnglishOnlyWhisperModelName(baseModelName);
	if (translate && (englishOnly || isTranslationUnsupportedWhisperModelName(baseModelName))) {
		throw new Error(`Whisper model ${modelName} does not support translation. Set MICME_WHISPER_CPP_MODEL to a translate-capable multilingual model or turn off MICME_TRANSLATE_TO_ENGLISH.`);
	}
	if (!englishOnly) return language;
	if (language === "auto") return "en";
	if (language !== "en") {
		throw new Error(`Whisper model ${modelName} is English-only. Set MICME_LANGUAGE=en (or auto), or select a multilingual model.`);
	}
	return language;
}
