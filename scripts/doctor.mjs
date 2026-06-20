#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const isWin = process.platform === "win32";
const micmeConfig = loadMicmeConfig();
const DEFAULT_TRANSCRIBE_BACKEND = "auto";
const TRANSCRIBE_BACKENDS = new Set(["auto", "whisper.cpp", "python", "custom"]);

function getMicmeConfigPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  return join(agentDir, "micme.json");
}

function loadMicmeConfig() {
  const path = getMicmeConfigPath();
  if (!existsSync(path)) return { path, found: false, values: {} };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { path, found: true, values: {}, error: "top-level value must be a JSON object" };
    }

    const values = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.startsWith("MICME_")) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") values[key] = String(value);
    }
    return { path, found: true, values };
  } catch (error) {
    return { path, found: true, values: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function env(name) {
  return process.env[name] ?? micmeConfig.values[name];
}

function expandConfigValue(value) {
  const home = process.env.HOME || homedir();
  const withHome = value.startsWith("~/") && home ? `${home}${value.slice(1)}` : value;
  return withHome.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
    const key = braced || bare || "";
    return process.env[key] ?? micmeConfig.values[key] ?? "";
  });
}

function envPath(name) {
  const value = env(name);
  return value ? expandConfigValue(value) : undefined;
}

function which(names) {
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const name of names) {
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const candidate = join(dir, isWin && !/\.[^.]+$/.test(name) ? `${name}${ext}` : name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

function resolveExecutable(value) {
  const expanded = expandConfigValue(value);
  if (/[\\/]/.test(expanded)) return expanded;
  return which([expanded]) || expanded;
}

function ok(label, detail = "") {
  console.log(`✓ ${label}${detail ? `: ${detail}` : ""}`);
}

function warn(label, detail = "") {
  console.log(`! ${label}${detail ? `: ${detail}` : ""}`);
}

function info(label, detail = "") {
  console.log(`- ${label}${detail ? `: ${detail}` : ""}`);
}

function summarizeConfiguredCommand(value) {
  const trimmed = value.trim();
  const placeholders = [...new Set([...trimmed.matchAll(/\{([A-Za-z]+?)(Raw)?\}/g)].map((match) => match[0]))];
  const placeholderText = placeholders.length ? `; placeholders: ${placeholders.join(", ")}` : "";
  return `configured (${trimmed.length} chars${placeholderText}; full value redacted)`;
}

function getTranscribeBackend() {
  const raw = env("MICME_TRANSCRIBE_BACKEND")?.trim();
  return TRANSCRIBE_BACKENDS.has(raw) ? raw : DEFAULT_TRANSCRIBE_BACKEND;
}

function getTranscriptionMode() {
  return env("MICME_TRANSCRIPTION_MODE") === "stream" ? "stream" : "clip";
}

function getTranslateToEnglishLanguage() {
  const value = env("MICME_TRANSLATE_TO_ENGLISH")?.trim();
  if (!value || /^(0|false|no|off)$/i.test(value)) return undefined;
  return value;
}

function toMultilingualWhisperModelName(modelName) {
  return modelName.replace(/\.en$/i, "");
}

function getTranslationAwareWhisperModelName(modelName) {
  return getTranslateToEnglishLanguage() ? toMultilingualWhisperModelName(modelName) : modelName;
}

function isEnglishOnlyWhisperModelName(modelName) {
  return Boolean(modelName && /\.en$/i.test(modelName));
}

function inferWhisperCppModelName(modelPath) {
  return modelPath.match(/(?:^|[/\\])ggml-(.+)\.(?:bin|gguf)$/i)?.[1];
}

function getPythonWhisperModelName() {
  return getTranslationAwareWhisperModelName(env("MICME_WHISPER_MODEL") || "base.en");
}

function resolveWhisperCppModelSummary() {
  const explicit = envPath("MICME_WHISPER_CPP_MODEL");
  if (explicit) {
    return {
      path: explicit,
      modelName: inferWhisperCppModelName(explicit),
      source: "MICME_WHISPER_CPP_MODEL explicit path",
      exists: existsSync(explicit),
    };
  }
  const defaultModel = getTranslationAwareWhisperModelName(env("MICME_DEFAULT_WHISPER_CPP_MODEL") || "small.en");
  const modelDir = expandConfigValue(env("MICME_MODEL_DIR") || join(homedir(), ".cache", "whisper.cpp"));
  const path = join(modelDir, `ggml-${defaultModel}.bin`);
  return {
    path,
    modelName: defaultModel,
    source: env("MICME_DEFAULT_WHISPER_CPP_MODEL") ? "MICME_DEFAULT_WHISPER_CPP_MODEL" : "default whisper.cpp model name",
    exists: existsSync(path),
  };
}

function resolveBackendPlan({ whisperCpp, whisperStream, whisper, transcribeCommand }) {
  const requestedBackend = getTranscribeBackend();
  const mode = getTranscriptionMode();
  const whisperCppAvailable = Boolean(whisperCpp && existsSync(whisperCpp));
  const whisperStreamAvailable = Boolean(whisperStream && existsSync(whisperStream));
  const pythonAvailable = Boolean(whisper && existsSync(whisper));
  const model = resolveWhisperCppModelSummary();
  const warnings = [];

  const invalidBackend = env("MICME_TRANSCRIBE_BACKEND")?.trim();
  if (invalidBackend && !TRANSCRIBE_BACKENDS.has(invalidBackend)) warnings.push(`Invalid MICME_TRANSCRIBE_BACKEND=${invalidBackend}; using auto.`);

  if (mode === "stream") {
    if (requestedBackend === "python") {
      return { requestedBackend, effectiveBackend: "none", effectiveModel: "unavailable", reason: "Streaming mode requires whisper.cpp; Python Whisper only supports clip transcription.", warnings };
    }
    if (requestedBackend === "custom") {
      return { requestedBackend, effectiveBackend: "none", effectiveModel: "unavailable", reason: "Streaming mode requires whisper.cpp; custom transcribe commands only support clip transcription.", warnings };
    }
    if (whisperStreamAvailable) {
      return { requestedBackend, effectiveBackend: "whisper.cpp", binary: whisperStream, model, effectiveModel: model.path, reason: "streaming uses whisper-stream", warnings };
    }
    return { requestedBackend, effectiveBackend: "none", effectiveModel: "unavailable", reason: "MICME_TRANSCRIPTION_MODE=stream but whisper-stream was not found.", warnings };
  }

  if (requestedBackend === "custom") {
    if (transcribeCommand?.trim()) return { requestedBackend, effectiveBackend: "custom", effectiveModel: "unknown", reason: "MICME_TRANSCRIBE_BACKEND=custom", warnings };
    return { requestedBackend, effectiveBackend: "none", effectiveModel: "unavailable", reason: "MICME_TRANSCRIBE_BACKEND=custom but MICME_TRANSCRIBE_COMMAND is not set.", warnings };
  }
  if (requestedBackend === "whisper.cpp") {
    if (whisperCppAvailable) return { requestedBackend, effectiveBackend: "whisper.cpp", binary: whisperCpp, model, effectiveModel: model.path, reason: "MICME_TRANSCRIBE_BACKEND=whisper.cpp", warnings };
    return { requestedBackend, effectiveBackend: "none", effectiveModel: "unavailable", reason: "MICME_TRANSCRIBE_BACKEND=whisper.cpp but whisper.cpp was not found.", warnings };
  }
  if (requestedBackend === "python") {
    if (pythonAvailable) return { requestedBackend, effectiveBackend: "python", binary: whisper, effectiveModel: getPythonWhisperModelName(), reason: "MICME_TRANSCRIBE_BACKEND=python", warnings };
    return { requestedBackend, effectiveBackend: "none", effectiveModel: "unavailable", reason: "MICME_TRANSCRIBE_BACKEND=python but the `whisper` CLI was not found.", warnings };
  }

  if (transcribeCommand?.trim()) return { requestedBackend, effectiveBackend: "custom", effectiveModel: "unknown", reason: "auto selected custom command because MICME_TRANSCRIBE_COMMAND is configured", warnings };
  if (whisperCppAvailable) return { requestedBackend, effectiveBackend: "whisper.cpp", binary: whisperCpp, model, effectiveModel: model.path, reason: "auto selected whisper.cpp because a whisper.cpp binary is available", warnings };
  if (pythonAvailable) return { requestedBackend, effectiveBackend: "python", binary: whisper, effectiveModel: getPythonWhisperModelName(), reason: "auto selected Python Whisper because whisper.cpp is unavailable", warnings };
  return { requestedBackend, effectiveBackend: "none", effectiveModel: "unavailable", reason: "No Micme transcription backend found.", warnings };
}

function printBackendPlanDiagnostics(plan) {
  info("requested backend", plan.requestedBackend);
  if (plan.effectiveBackend === "none") warn("effective backend", plan.reason);
  else ok("effective backend", `${plan.effectiveBackend} (${plan.reason})`);

  if (plan.effectiveBackend === "custom") info("effective model", "unknown; controlled by MICME_TRANSCRIBE_COMMAND");
  else if (plan.effectiveBackend === "whisper.cpp") {
    info("effective model", `${plan.effectiveModel} (${plan.model?.source || "whisper.cpp model"})`);
    if (plan.model && !plan.model.exists) warn("effective whisper.cpp model is missing", plan.effectiveModel);
  } else if (plan.effectiveBackend === "python") info("effective model", plan.effectiveModel);
  else info("effective model", "unavailable");

  const translateLanguage = getTranslateToEnglishLanguage();
  if (translateLanguage) {
    ok("translation", `${translateLanguage} -> English`);
    if (plan.effectiveBackend === "custom") warn("translation backend", "custom transcribe commands must implement translation themselves");
    if (plan.effectiveBackend === "whisper.cpp" && isEnglishOnlyWhisperModelName(plan.model?.modelName)) warn("translation model", `${plan.model.modelName} appears to be English-only; use a multilingual model`);
    if (plan.effectiveBackend === "python" && isEnglishOnlyWhisperModelName(plan.effectiveModel)) warn("translation model", `${plan.effectiveModel} appears to be English-only; use a multilingual model`);
  } else {
    info("translation", "off");
  }

  for (const warning of plan.warnings) warn("backend warning", warning);
}

function printConfigDiagnostics() {
  if (micmeConfig.error) warn("micme.json invalid", `${micmeConfig.path}: ${micmeConfig.error}`);
  else if (micmeConfig.found) ok("micme.json loaded", `${micmeConfig.path} (${Object.keys(micmeConfig.values).length} MICME_* key(s))`);
  else info("micme.json", `not found; /micme conf will create ${micmeConfig.path}`);

  const micmeEnvKeys = Object.keys(process.env).filter((key) => key.startsWith("MICME_")).sort((a, b) => a.localeCompare(b));
  const overrides = micmeEnvKeys.filter((key) => micmeConfig.values[key] !== undefined);
  const shellOnly = micmeEnvKeys.filter((key) => micmeConfig.values[key] === undefined);
  if (overrides.length) warn("shell env overrides micme.json", overrides.join(", "));
  if (shellOnly.length) info("MICME_* shell values", shellOnly.join(", "));
}

async function main() {
  console.log("Micme doctor\n");
  info("platform", `${process.platform} ${process.arch}`);
  info("node", process.version);
  printConfigDiagnostics();

  const pi = which(["pi"]);
  if (pi) ok("pi CLI", pi);
  else warn("pi CLI not found", "install @earendil-works/pi-coding-agent or use this as a package from pi");

  const ffmpeg = which(["ffmpeg"]);
  if (ffmpeg) ok("ffmpeg recorder", ffmpeg);
  else warn("ffmpeg recorder missing", "install ffmpeg or set MICME_RECORD_COMMAND");

  const configuredWhisperCpp = env("MICME_WHISPER_CPP_BIN");
  const whisperCpp = configuredWhisperCpp ? resolveExecutable(configuredWhisperCpp) : which(["whisper-cli", "whisper-cpp"]);
  const whisperCppModel = envPath("MICME_WHISPER_CPP_MODEL");
  if (whisperCpp && existsSync(whisperCpp)) ok("whisper.cpp binary", whisperCpp);
  else if (configuredWhisperCpp) warn("MICME_WHISPER_CPP_BIN is set but not found", resolveExecutable(configuredWhisperCpp));
  else warn("whisper.cpp binary missing", "recommended backend for portable local transcription");

  const configuredWhisperStream = env("MICME_WHISPER_STREAM_BIN");
  const whisperStream = configuredWhisperStream ? resolveExecutable(configuredWhisperStream) : which(["whisper-stream"]);
  if (whisperStream && existsSync(whisperStream)) ok("whisper-stream binary", whisperStream);
  else if (configuredWhisperStream) warn("MICME_WHISPER_STREAM_BIN is set but not found", resolveExecutable(configuredWhisperStream));
  else info("whisper-stream binary", "not installed; only needed for MICME_TRANSCRIPTION_MODE=stream");

  if (whisperCppModel) {
    try {
      await access(whisperCppModel);
      ok("MICME_WHISPER_CPP_MODEL", whisperCppModel);
    } catch {
      const auto = env("MICME_AUTO_DOWNLOAD_MODEL") !== "0";
      warn("MICME_WHISPER_CPP_MODEL is set but not readable", auto ? `${whisperCppModel} (Micme will try to download if it is a standard ggml model path)` : whisperCppModel);
    }
  } else {
    const defaultModel = getTranslationAwareWhisperModelName(env("MICME_DEFAULT_WHISPER_CPP_MODEL") || "small.en");
    const modelDir = expandConfigValue(env("MICME_MODEL_DIR") || join(homedir(), ".cache", "whisper.cpp"));
    info("MICME_WHISPER_CPP_MODEL", `not set; Micme defaults to ${modelDir}/ggml-${defaultModel}.bin and auto-downloads when needed`);
  }

  const whisper = which(["whisper"]);
  if (whisper) ok("openai-whisper fallback", whisper);
  else info("openai-whisper fallback", "not installed");

  const transcribeCommand = env("MICME_TRANSCRIBE_COMMAND");
  if (transcribeCommand) ok("custom transcribe command", summarizeConfiguredCommand(transcribeCommand));
  else info("custom transcribe command", "not set");

  printBackendPlanDiagnostics(resolveBackendPlan({ whisperCpp, whisperStream, whisper, transcribeCommand }));

  const recordCommand = env("MICME_RECORD_COMMAND");
  if (recordCommand) ok("custom record command", summarizeConfiguredCommand(recordCommand));
  else info("custom record command", "not set");

  console.log("\nRecommended macOS setup:");
  console.log("  brew install ffmpeg whisper-cpp");
  console.log("  # Then use /micme conf, or let Micme auto-download the default model on first use.");

  if (process.platform === "darwin" && ffmpeg) {
    console.log("\nmacOS microphone devices:");
    const listed = spawnSync(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      encoding: "utf8",
      timeout: 8000,
    });
    const deviceOutput = `${listed.stdout || ""}\n${listed.stderr || ""}`.trim();
    if (deviceOutput) console.log(deviceOutput);
    const macbookMic = deviceOutput.match(/\[(\d+)\]\s+MacBook Pro Microphone/i);
    if (macbookMic) {
      const current = env("MICME_AUDIO_DEVICE") || "0";
      if (current !== macbookMic[1]) {
        warn("MacBook Pro microphone is not the configured default", `try: MICME_AUDIO_DEVICE=${macbookMic[1]} pi`);
      }
    }
    console.log("\nSet MICME_AUDIO_DEVICE to the numeric audio device id if device 0 is wrong.");
  }

  if (ffmpeg) {
    try {
      const version = execFileSync(ffmpeg, ["-version"], { encoding: "utf8", timeout: 3000 }).split("\n")[0];
      info("ffmpeg version", version);
    } catch {
      warn("could not read ffmpeg version");
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
