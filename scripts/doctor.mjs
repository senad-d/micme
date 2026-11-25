#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getPythonWhisperBinary, getWhisperCppBinary, resolveTranscriptionPlan } from "../src/backends.ts";
import { env, getAutoDownloadModel, getConfiguredRecorderInput, getLegacyStreamSettings, getTranscriptionMode, getTranslateToEnglishLanguage, reloadMicmeConfig } from "../src/config.ts";
import { isRegularFile, resolveWhisperCppModel } from "../src/models.ts";
import { findExecutable } from "../src/processes.ts";
import { probeLiveWorker } from "../src/streaming.ts";
import { sanitizeTerminalOutput } from "../src/terminal-text.ts";

const micmeConfig = reloadMicmeConfig();

function ok(label, detail = "") {
  const safeLabel = sanitizeTerminalOutput(label);
  const safeDetail = sanitizeTerminalOutput(detail);
  console.log(`✓ ${safeLabel}${safeDetail ? `: ${safeDetail}` : ""}`);
}

function warn(label, detail = "") {
  const safeLabel = sanitizeTerminalOutput(label);
  const safeDetail = sanitizeTerminalOutput(detail);
  console.log(`! ${safeLabel}${safeDetail ? `: ${safeDetail}` : ""}`);
}

function info(label, detail = "") {
  const safeLabel = sanitizeTerminalOutput(label);
  const safeDetail = sanitizeTerminalOutput(detail);
  console.log(`- ${safeLabel}${safeDetail ? `: ${safeDetail}` : ""}`);
}

function summarizeConfiguredCommand(value) {
  const trimmed = value.trim();
  const placeholders = [...new Set(trimmed.match(/\{(?:audio|tempDir|transcript)(?:Raw)?\}/g) ?? [])];
  const placeholderText = placeholders.length ? `; placeholders: ${placeholders.join(", ")}` : "";
  return `configured (${trimmed.length} chars${placeholderText}; full value redacted)`;
}

function resolveDoctorBinary(resolver) {
  try {
    return { path: resolver() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function printWhisperCppModelDiagnostics(model) {
  if (model.exists) {
    ok("resolved whisper.cpp model", model.path);
  } else {
    const detail = getAutoDownloadModel() && model.downloadable ? `${model.path} (Micme will try to download this standard model when needed)` : model.path;
    warn("resolved whisper.cpp model is missing", detail);
  }
  if (model.translationFallbackFrom) info("translation model fallback", `${model.translationFallbackFrom} -> ${model.modelName}`);
}

async function printLiveDiagnostics(plan) {
  const input = getConfiguredRecorderInput(process.platform);
  info("live audio input", env("MICME_RECORD_COMMAND")?.trim() ? "custom recorder (MICME_RECORD_COMMAND)" : input || (process.platform === "win32" ? "automatic DirectShow device at capture time" : "no built-in recorder"));
  const legacy = getLegacyStreamSettings();
  if (legacy.length) info("ignored legacy stream settings", `${legacy.join(", ")}; stream uses micme-live and the Audio input`);
  const live = plan.live;
  if (!live) return;
  info("live worker binary", live.binary);
  info("live language", live.language);
  info("live VAD model path", live.vadModelPath);
  info("live final clip refinement", live.finalizeWithClip ? "on" : "off");
  if (!isRegularFile(live.vadModelPath)) warn("live VAD weights not present as a regular file", live.vadModelPath);
  if (micmeConfig.error) return;
  try {
    await probeLiveWorker(live.binary);
    ok("live worker protocol", "Worker v1 available; model readiness and capture not tested");
  } catch (error) {
    warn("live worker protocol unavailable", error instanceof Error ? error.message : String(error));
  }
}

function printBackendPlanDiagnostics(plan) {
  info("requested backend", plan.requestedBackend);
  if (plan.effectiveBackend === "none") warn("effective backend", plan.reason);
  else ok("effective backend", `${plan.effectiveBackend} (${plan.reason})`);

  if (plan.effectiveBackend === "custom") {
    info("effective model", "unknown; controlled by MICME_TRANSCRIBE_COMMAND");
  } else if (plan.effectiveBackend === "whisper.cpp") {
    info("effective model path", plan.modelPath || "unavailable");
    info("effective model name", plan.modelName || "unknown");
    info("effective model source", plan.modelSource || "unknown");
  } else if (plan.effectiveBackend === "python") {
    info("effective model name", plan.modelName || "unknown");
    info("effective model source", plan.modelSource || "unknown");
  } else {
    info("effective model", "unavailable");
  }

  const translateLanguage = getTranslateToEnglishLanguage();
  if (translateLanguage) ok("translation", `${translateLanguage} -> English`);
  else info("translation", "off");

  for (const warning of plan.warnings) warn("backend warning", warning);
}

function printConfigDiagnostics() {
  if (micmeConfig.error) warn("micme.json invalid", `${micmeConfig.path}: ${micmeConfig.error}`);
  else if (existsSync(micmeConfig.path)) ok("micme.json loaded", `${micmeConfig.path} (${Object.keys(micmeConfig.values).length} MICME_* key(s))`);
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

  // Doctor reports Pi's shell command; it never spawns it.
  const pi = findExecutable(["pi"], { allowWindowsBatch: true });
  if (pi) ok("pi CLI", pi);
  else warn("pi CLI not found", "install @earendil-works/pi-coding-agent or use this as a package from pi");

  const ffmpeg = findExecutable(["ffmpeg"]);
  if (ffmpeg) ok("ffmpeg recorder", ffmpeg);
  else warn("ffmpeg recorder missing", "install ffmpeg or set MICME_RECORD_COMMAND");

  const whisperCpp = resolveDoctorBinary(getWhisperCppBinary);
  if (whisperCpp.path) ok("whisper.cpp binary", whisperCpp.path);
  else if (whisperCpp.error) warn("whisper.cpp binary", whisperCpp.error);
  else warn("whisper.cpp binary missing", "recommended backend for portable local transcription");

  const transcriptionMode = getTranscriptionMode();
  info("transcription mode", transcriptionMode);
  const whisperCppModel = resolveWhisperCppModel({ transcriptionMode });
  printWhisperCppModelDiagnostics(whisperCppModel);

  const whisper = getPythonWhisperBinary();
  if (whisper) ok("openai-whisper fallback", whisper);
  else info("openai-whisper fallback", "not installed");

  const transcribeCommand = env("MICME_TRANSCRIBE_COMMAND");
  if (transcribeCommand) ok("custom transcribe command", summarizeConfiguredCommand(transcribeCommand));
  else info("custom transcribe command", "not set");

  const plan = resolveTranscriptionPlan({
    transcriptionMode,
    customCommand: transcribeCommand || null,
    whisperCppBinary: whisperCpp.path || null,
    whisperCppBinaryError: whisperCpp.error,
    pythonWhisperBinary: whisper || null,
    whisperCppModel,
  });
  printBackendPlanDiagnostics(plan);
  if (transcriptionMode === "stream") await printLiveDiagnostics(plan);

  const recordCommand = env("MICME_RECORD_COMMAND");
  if (recordCommand) ok("custom record command", summarizeConfiguredCommand(recordCommand));
  else info("custom record command", "not set");

  console.log("\nRecommended macOS setup:");
  console.log("  brew install ffmpeg whisper-cpp");
  console.log("  # Then use /micme conf, or let Micme auto-download the default model on first use.");

  if (transcriptionMode === "clip" && process.platform === "darwin" && ffmpeg) {
    console.log("\nmacOS microphone devices:");
    const listed = spawnSync(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      encoding: "utf8",
      timeout: 8000,
    });
    const deviceOutput = sanitizeTerminalOutput(`${listed.stdout || ""}\n${listed.stderr || ""}`);
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
  console.error(sanitizeTerminalOutput(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
