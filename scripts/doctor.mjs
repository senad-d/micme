#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { getPythonWhisperBinary, getWhisperCppBinary, resolveTranscriptionPlan } from "../src/backends.ts";
import { env, expandConfigPath, getAudioInputConfigKey, getAutoDownloadModel, getConfiguredRecorderInput, getLegacyStreamSettings, getLiveSpeechLanguage, getTranscribeBackend, getTranscriptionMode, getTransferOptions, getTranslateToEnglishLanguage, reloadMicmeConfig } from "../src/config.ts";
import { getWhisperVadModelPath, isEnglishOnlyWhisperModelName, isRegularFile, isTranslationUnsupportedWhisperModelName, resolveWhisperCppModel } from "../src/models.ts";
import { findExecutable } from "../src/processes.ts";
import { probeLiveWorker } from "../src/streaming.ts";
import { sanitizeTerminalOutput } from "../src/terminal-text.ts";
import { getCatalogVariant, getManagedCatalogVariant, getWhisperVariant, whisperVadVariant } from "../src/transfer/catalog.ts";
import { COMPUTE_MODES } from "../src/transfer/contracts.ts";
import { getEngineEvidence } from "../src/transfer/engine-evidence.ts";
import { ensureManaged, ensurePinnedModelFile, getDefaultWhisperVadModelPath, ManagedModelError } from "../src/transfer/managed.ts";

function print(mark, label, detail) {
  const safeDetail = sanitizeTerminalOutput(detail).replaceAll("\n", " ");
  console.log(`${mark} ${label}${safeDetail ? `: ${safeDetail}` : ""}`);
}

const ok = print.bind(undefined, "✓");
const warn = print.bind(undefined, "!");
const info = print.bind(undefined, "-");

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

function yesNo(value) {
  return value ? "yes" : "no";
}

function printModelCatalog(variant) {
  const { rights, runtime, reason, measurements, traits } = variant;
  info("artifact catalog status", `rights: ${rights}; reference runtime: ${runtime}${reason ? `; ${reason}` : ""}`);
  if (traits) {
    info("model reference capabilities", `streaming: ${yesNo(traits.stream)}; batch: ${yesNo(traits.batch)}; long-form: ${yesNo(traits.longForm)}; translate to English: ${yesNo(traits.translateEn)}; detector: ${traits.vad}; not tested here`);
  } else {
    info("model reference capabilities", "unknown; no recorded trait snapshot");
  }
  if (!measurements.length) info("model reference measurement", "unknown; no measurements for this artifact");
  for (const { task, language, rig, device, wer, cer, xrt, disposition } of measurements) {
    const identity = device ? [device.label, device.id].filter(Boolean).join(" / ") : "unknown";
    const wordError = wer === null ? "unknown" : `${(100 * wer).toFixed(1)}%`;
    const characterError = cer === null ? "unknown" : `${(100 * cer).toFixed(1)}%`;
    info("model reference measurement", `${task} (${language}), ${rig}; measured device: ${identity}; WER ${wordError}, CER ${characterError}, xRT ${xrt ?? "unknown"}; ${disposition}; not measured here`);
  }
}

function nativeReferenceVariant(variant) {
  const actualCompute = getEngineEvidence(variant.id)?.traits?.actualCompute;
  if (!actualCompute || actualCompute === "unknown") return null;
  // Use the recorded scope to authorize the pin check, not to qualify this host.
  for (const { rig, device, task, language } of variant.measurements) {
    const qualified = getManagedCatalogVariant(variant.id, { rig, actualCompute, device }, task, language);
    if (qualified) return qualified;
  }
  return null;
}

async function verifyArtifactFiles(variant, native, signal) {
  if (native && variant.blobs.length === 1) {
    const dir = expandConfigPath(env("MICME_MODEL_DIR") || "");
    const [blob] = variant.blobs;
    // Native recognition prefers a preseed in an absolute MICME_MODEL_DIR.
    if (isAbsolute(dir) && basename(blob.path) === blob.path) {
      const path = join(dir, blob.path);
      try {
        await ensurePinnedModelFile(blob, path, { signal, missing: "No preseeded native model" });
        return path;
      } catch (error) {
        if (!(error instanceof ManagedModelError && error.code === "missing")) throw error;
      }
    }
  }
  return ensureManaged(variant, false, () => {}, signal);
}

async function printManagedIntegrity(label, variant, native = false) {
  try {
    const path = await verifyArtifactFiles(variant, native, new AbortController().signal);
    ok(label, `verified size and SHA-256 for all pinned files; primary: ${path}`);
  } catch (error) {
    switch (error instanceof ManagedModelError ? error.code : undefined) {
      case "missing":
        if (native) warn(label, `missing; install the exact pinned ${variant.blobs[0].path} offline in an absolute MICME_MODEL_DIR`);
        else warn(label, getAutoDownloadModel()
          ? "missing; install the exact pinned file(s) offline or let Micme download them when needed"
          : "missing; install the exact pinned file(s) offline (MICME_AUTO_DOWNLOAD_MODEL is off)");
        break;
      case "integrity":
        warn(label, "corrupt; size or SHA-256 mismatch. Use confirmed managed removal only for Micme-owned files; keep or move user-managed files yourself before installing a verified copy.");
        break;
      case "unqualified":
        warn(label, "not verified; no qualified managed variant available to this check. Choose an eligible artifact or unset MICME_ARTIFACT to use legacy dictation.");
        break;
      default:
        warn(label, "not verified; check cache permissions and use regular files and directories, not symlinks");
    }
  }
}

function printManualIntegrity(label, present, repair) {
  if (present) info(label, "present; user-managed file, not verified against a catalog pin");
  else warn(label, `not verified; ${repair}`);
}

function getRejectedClipModel(model) {
  if (model.source !== "explicit-path" || !getTranslateToEnglishLanguage()) return undefined;
  // Match Pi's clip preflight: an incompatible explicit selection never falls back.
  const modelName = model.translationFallbackFrom ?? model.modelName;
  const base = modelName?.replace(/-q\d+_\d+$/i, "");
  if (!isEnglishOnlyWhisperModelName(base) && !isTranslationUnsupportedWhisperModelName(base)) return undefined;
  const path = expandConfigPath(model.configuredValue);
  return { ...model, path, modelName, exists: isRegularFile(path), translationFallbackFrom: undefined };
}

async function printWhisperCppModelDiagnostics(model, effectiveBackend, rejectedModel) {
  info("Whisper path check", rejectedModel && model.translationFallbackFrom ? "file presence of resolver candidate only; not selected by Pi" : "file presence only");
  if (model.exists) ok("resolved whisper.cpp model", model.path);
  else warn("resolved whisper.cpp model is missing", model.path);
  if (rejectedModel) {
    info("configured Whisper model path", rejectedModel.path);
    warn("Pi clip translation", "The explicit model cannot translate to English. Pi will not substitute another model. Set MICME_WHISPER_CPP_MODEL to a translation-capable multilingual model or turn off MICME_TRANSLATE_TO_ENGLISH.");
    printManualIntegrity("ASR integrity", rejectedModel.exists, "the configured file is missing or not regular; set MICME_WHISPER_CPP_MODEL to an installed regular file");
    return;
  }
  if (model.translationFallbackFrom) info("translation model fallback", `${model.translationFallbackFrom} -> ${model.modelName}`);
  if (effectiveBackend !== "whisper.cpp" && effectiveBackend !== "none") {
    info("ASR integrity", "unknown; the selected backend manages its own model");
    return;
  }
  const variant = model.source !== "explicit-path" && getWhisperVariant(model.modelName);
  if (variant) printModelCatalog(variant);
  if (variant && model.downloadable) await printManagedIntegrity("ASR integrity", variant);
  else printManualIntegrity("ASR integrity", model.exists, "set MICME_WHISPER_CPP_MODEL to an installed regular file or select a supported managed model by name");
}

function printNativeReferenceRepairs(variant, options) {
  const { id, traits, measurements } = variant;
  const { actualCompute, boundDevice, translateEn, vad } = traits;
  if (getTranscribeBackend() === "whisper.cpp") {
    warn("artifact backend", "This native artifact is not a whisper.cpp model. Use MICME_TRANSCRIBE_BACKEND=auto or clear MICME_ARTIFACT to use legacy Whisper.");
  }
  const source = getTranslateToEnglishLanguage();
  const task = source ? "translate-en" : "transcribe";
  const language = getLiveSpeechLanguage(source);
  // These checks can rule out selections on published evidence alone. A match
  // is not local qualification and does not affect the separate file check.
  const measured = measurements.some(({ rig, device, language: recorded }) => (language === "auto" || language === recorded) &&
    getManagedCatalogVariant(id, { rig, device, actualCompute }, task, recorded));
  if (!measured) {
    warn("artifact task and language", source && !translateEn
      ? "The published runtime does not support translation to English. Turn off MICME_TRANSLATE_TO_ENGLISH or choose a translation-capable model."
      : "No verified reference for the configured task and source language. Choose a qualified model and language in /micme setup.");
  }
  const detector = vad === "native" ? "model" : vad;
  if (options.MICME_DETECTOR !== detector) warn("artifact detector", `The published runtime uses MICME_DETECTOR=${detector}; review that selection in /micme conf.`);
  const compute = options.MICME_COMPUTE;
  if (compute !== "auto" && compute !== actualCompute && compute !== boundDevice?.id) {
    warn("artifact compute", "The requested compute has no matching reference for this artifact. Review qualified devices in /micme setup or use MICME_COMPUTE=auto.");
  }
}

async function printArtifactDiagnostics(options) {
  const id = options.MICME_ARTIFACT;
  const variant = getCatalogVariant(id);
  if (!variant) {
    warn("configured artifact", "unknown ASR variant ID; select an exact catalog variant or unset MICME_ARTIFACT");
    return;
  }
  info("configured artifact", variant.id);
  const native = nativeReferenceVariant(variant);
  printModelCatalog(native ?? variant);
  if (native) {
    printNativeReferenceRepairs(native, options);
    const binary = findExecutable(["micme-recognizer"]);
    if (binary && isAbsolute(binary)) info("native recognizer", "found on an absolute PATH entry; path discovery only (not probed)");
    else warn("native recognizer", "micme-recognizer not found on an absolute PATH entry; see native/recognizer/README.md for the matching helper, or clear MICME_ARTIFACT to use legacy dictation.");
  }
  await printManagedIntegrity("ASR integrity", native ?? variant, native !== null);
}

async function printLiveDiagnostics(live) {
  const vadPath = live?.vadModelPath ?? getWhisperVadModelPath();
  info("live VAD model path", vadPath);
  const present = isRegularFile(vadPath);
  if (!present) warn("live VAD weights not present as a regular file", vadPath);
  if (vadPath === getDefaultWhisperVadModelPath()) await printManagedIntegrity("VAD integrity", whisperVadVariant());
  else printManualIntegrity("VAD integrity", present, "set MICME_VAD_MODEL to an installed VAD file, unset it to use the pinned default, or choose clip mode");
  if (!live) {
    info("live worker protocol", "not probed; repair the stream configuration reported above");
    return;
  }
  info("live worker binary", live.binary);
  info("live language", live.language);
  info("live final clip refinement", live.finalizeWithClip ? "on" : "off");
  try {
    await probeLiveWorker(live.binary);
    ok("live worker protocol", "Worker v1 available; model readiness and capture not tested");
  } catch {
    warn("live worker protocol unavailable", "Could not confirm Worker v1. Rebuild it using native/live/README.md or correct MICME_LIVE_BIN.");
  }
}

function printCaptureDiagnostics(recordCommand, ffmpeg) {
  const platform = process.platform;
  const input = getConfiguredRecorderInput(platform);
  if (recordCommand) {
    ok("custom record command", summarizeConfiguredCommand(recordCommand));
    info("configured audio input", "custom recorder; input controlled by MICME_RECORD_COMMAND");
  } else {
    info("custom record command", "not set");
    info("configured audio input", input || (platform === "win32" ? "automatic DirectShow selection at capture time" : "no built-in recorder"));
    if (ffmpeg && (input || platform === "win32")) {
      info("audio repair", `If a take fails to capture, check terminal microphone permission and review inputs in /micme devices before changing ${getAudioInputConfigKey(platform)}.`);
    }
  }
  info("capture readiness", "not tested; actual device, channel and fallback unknown; permissions not checked; no samples observed");
}

function printTransferDiagnostics(options, transcriptionMode) {
  const translationSource = getTranslateToEnglishLanguage();
  info("configured speech task", translationSource ? `translate to English (source: ${translationSource})` : "transcribe");
  info("configured speech language", env("MICME_LANGUAGE")?.trim() || "not set (backend default)");
  if (options.MICME_PREFERRED_LANGUAGES.length) info("preferred languages", options.MICME_PREFERRED_LANGUAGES.join(", "));

  const compute = options.MICME_COMPUTE;
  info("requested compute", COMPUTE_MODES.includes(compute) ? compute : "explicit device ID (not validated; value redacted)");
  info("actual compute and bound device", "unknown; model not loaded");
  info("loaded model capabilities", "unknown; catalog observations are not a local load test");
  const legacy = getLegacyStreamSettings();
  if (legacy.length) {
    const detail = transcriptionMode === "stream" && !options.MICME_ARTIFACT ? "; stream uses micme-live and the Audio input" : "";
    info("ignored legacy stream settings", `${legacy.join(", ")}${detail}`);
    info("SDL migration", "For legacy Whisper stream mode, install micme-live and set MICME_LIVE_BIN if needed, or use clip mode. Retain saved SDL settings; doctor makes no changes.");
  }
  if (!options.MICME_ARTIFACT && compute !== "auto") info("compute configuration", "MICME_COMPUTE applies to explicit artifact selection, not the legacy backend");
  if (["MICME_MODEL_IDLE", "MICME_CHUNKING", "MICME_DETECTOR"].some((key) => env(key) !== undefined)) {
    info("configured recognition preferences", `idle: ${options.MICME_MODEL_IDLE}; chunking: ${options.MICME_CHUNKING ? "on" : "off"}; detector: ${options.MICME_DETECTOR}; not exercised here`);
  }
  if (["MICME_LOCAL_LID", "MICME_REMOVE_FILLERS", "MICME_SCRIPT"].some((key) => env(key) !== undefined)) {
    info("configured language rules", `local language detection: ${options.MICME_LOCAL_LID ? "on" : "off"}; filler removal: ${options.MICME_REMOVE_FILLERS ? "on" : "off"}; script: ${options.MICME_SCRIPT}; not exercised here`);
  }
  if (env("MICME_HISTORY") !== undefined || env("MICME_RETENTION") !== undefined) {
    const retention = options.MICME_RETENTION;
    const request = retention.kind === "count" ? `count:${retention.count}` : retention.kind === "days" ? `days:${retention.days}` : "never";
    info("configured history preferences", `history: ${options.MICME_HISTORY ? "on" : "off"}; requested retention: ${request}; no library or active policy inspected`);
  }

  const provider = options.MICME_POLISH_PROVIDER;
  const hook = options.MICME_OUTPUT_HOOK;
  info("final processing", provider || hook ? `${provider ?? "hook only"}; explicit action only (not tested)` : "not selected");
  const privateFields = [
    options.MICME_POLISH_ENDPOINT && "endpoint", options.MICME_POLISH_MODEL && "model",
    options.MICME_POLISH_PROMPT && "prompt", options.MICME_POLISH_KEY_ENV && "credential source", hook && "hook",
    options.MICME_WORDS.length && "words", options.MICME_FILLERS.length && "fillers",
  ].filter(Boolean);
  if (privateFields.length) info("processing configuration", `${privateFields.join(", ")} configured; values redacted`);
}

function printBackendPlanDiagnostics(plan, candidate) {
  info("requested backend", plan.requestedBackend);
  if (plan.effectiveBackend === "none") warn("effective backend", plan.reason);
  else ok("effective backend", `${plan.effectiveBackend} (${plan.reason})`);

  if (plan.effectiveBackend === "custom") {
    info("effective model", "unknown; controlled by MICME_TRANSCRIBE_COMMAND");
  } else if (plan.effectiveBackend === "whisper.cpp") {
    // Preserve the legacy resolver fields for diagnostics consumers.
    info("effective model path", candidate?.path || plan.modelPath || "unavailable");
    info("effective model name", candidate?.modelName || plan.modelName || "unknown");
    info("effective model source", plan.modelSource || "unknown");
    if (candidate) info("effective model status", "resolver projection only; Pi rejects the configured model before capture");
  } else if (plan.effectiveBackend === "python") {
    info("effective model name", plan.modelName || "unknown");
    info("effective model source", plan.modelSource || "unknown");
  } else {
    info("effective model", "unavailable");
  }

  for (const warning of plan.warnings) warn("backend warning", warning);
}

function printConfigDiagnostics(micmeConfig, keyEnv) {
  if (existsSync(micmeConfig.path)) ok("micme.json loaded", `${micmeConfig.path} (${Object.keys(micmeConfig.values).length} MICME_* key(s))`);
  else info("micme.json", `not found; /micme conf will create ${micmeConfig.path}`);

  // A shell override can hide a saved credential source, but neither alias belongs in diagnostics.
  const hiddenKeys = new Set([keyEnv, micmeConfig.values.MICME_POLISH_KEY_ENV]);
  const micmeEnvKeys = Object.keys(process.env).filter((key) => key.startsWith("MICME_") && !hiddenKeys.has(key)).sort((a, b) => a.localeCompare(b));
  const overrides = micmeEnvKeys.filter((key) => micmeConfig.values[key] !== undefined);
  const shellOnly = micmeEnvKeys.filter((key) => micmeConfig.values[key] === undefined);
  if (overrides.length) warn("shell env overrides micme.json", overrides.join(", "));
  if (shellOnly.length) info("MICME_* shell values", shellOnly.join(", "));
}

function loadDoctorConfig() {
  // Use the standalone default without loading Pi. Restore the original shell
  // setting before resolving legacy paths that may reference environment values.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const useDefault = !agentDir?.trim();
  if (useDefault) process.env.PI_CODING_AGENT_DIR = join(homedir(), ".pi", "agent");
  try {
    const micmeConfig = reloadMicmeConfig();
    return { micmeConfig, options: micmeConfig.error ? null : getTransferOptions() };
  } finally {
    if (useDefault && agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else if (useDefault) process.env.PI_CODING_AGENT_DIR = agentDir;
  }
}

async function main() {
  console.log("Micme doctor\n");
  info("platform", `${process.platform} ${process.arch}`);
  info("node", process.version);
  const { micmeConfig, options } = loadDoctorConfig();
  if (!options) {
    warn("micme.json invalid", `${micmeConfig.path}: ${micmeConfig.error}`);
    info("configuration repair", "Correct the saved setting or its shell override before rerunning the doctor; no probes run.");
    return;
  }
  printConfigDiagnostics(micmeConfig, options.MICME_POLISH_KEY_ENV);

  // Only Worker v1 gets a protocol probe; discovery does not run Pi or FFmpeg.
  const pi = findExecutable(["pi"], { allowWindowsBatch: true });
  if (pi) ok("pi CLI", pi);
  else warn("pi CLI not found", "install @earendil-works/pi-coding-agent to use the Pi extension; not required for doctor");

  const ffmpeg = findExecutable(["ffmpeg"]);
  const recordCommand = env("MICME_RECORD_COMMAND")?.trim();
  if (ffmpeg) ok("ffmpeg recorder", ffmpeg);
  else if (recordCommand) info("ffmpeg recorder", "not found; a custom recorder is configured");
  else warn("ffmpeg recorder missing", "install ffmpeg or set MICME_RECORD_COMMAND");
  printCaptureDiagnostics(recordCommand, ffmpeg);

  const transcriptionMode = getTranscriptionMode();
  info("transcription mode", transcriptionMode);
  info("automatic model downloads", getAutoDownloadModel() ? "allowed during use; never by doctor" : "off");
  printTransferDiagnostics(options, transcriptionMode);
  if (options.MICME_ARTIFACT) {
    info("requested backend", getTranscribeBackend());
    info("effective backend", "not probed for explicit artifact selection; no legacy fallback");
    await printArtifactDiagnostics(options);
    return;
  }

  const whisperCpp = resolveDoctorBinary(getWhisperCppBinary);
  if (whisperCpp.path) ok("whisper.cpp binary", whisperCpp.path);
  else if (whisperCpp.error) warn("whisper.cpp binary", whisperCpp.error);
  else warn("whisper.cpp binary missing", "install the whisper.cpp CLI for clip mode and local sample review");

  const whisperCppModel = resolveWhisperCppModel({ transcriptionMode });

  const whisper = getPythonWhisperBinary();
  if (whisper) ok("openai-whisper fallback", whisper);
  else info("openai-whisper fallback", "not installed");

  const transcribeCommand = env("MICME_TRANSCRIBE_COMMAND");
  if (transcribeCommand) ok("custom transcribe command", summarizeConfiguredCommand(transcribeCommand));
  else info("custom transcribe command", "not set");

  const rejectedClipModel = transcriptionMode === "clip" ? getRejectedClipModel(whisperCppModel) : undefined;
  const plan = resolveTranscriptionPlan({
    transcriptionMode,
    customCommand: transcribeCommand || null,
    whisperCppBinary: whisperCpp.path || null,
    whisperCppBinaryError: whisperCpp.error,
    pythonWhisperBinary: whisper || null,
    whisperCppModel: rejectedClipModel ?? whisperCppModel,
  });
  const rejectedModel = plan.effectiveBackend === "whisper.cpp" ? rejectedClipModel : undefined;
  printBackendPlanDiagnostics(plan, rejectedModel ? whisperCppModel : undefined);
  await printWhisperCppModelDiagnostics(whisperCppModel, plan.effectiveBackend, rejectedModel);
  if (transcriptionMode === "stream") await printLiveDiagnostics(plan.live);
  if (process.platform === "darwin" && (!ffmpeg || !whisperCpp.path)) info("macOS prerequisites", "Install the missing ffmpeg or whisper-cpp package with Homebrew.");
}

if (import.meta.main) await main().catch(() => {
  console.error("Micme doctor could not complete its checks. Check configuration and local file permissions.");
  process.exitCode = 1;
});
