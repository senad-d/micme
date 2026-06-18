#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const isWin = process.platform === "win32";
const dotEnv = loadDotEnv(process.cwd());

function loadDotEnv(cwd) {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return { path: "", values: {} };
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !match[1].startsWith("MICME_")) continue;
    let value = match[2] || "";
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    value = value.replace(/^~\//, `${process.env.HOME || ""}/`);
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => values[braced || bare] ?? process.env[braced || bare] ?? "");
    values[match[1]] = value;
  }
  return { path, values };
}

function env(name) {
  return process.env[name] ?? dotEnv.values[name];
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
  const expanded = value.replace(/^~\//, `${process.env.HOME || ""}/`);
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

async function main() {
  console.log("Micme doctor\n");
  info("platform", `${process.platform} ${process.arch}`);
  info("node", process.version);
  if (dotEnv.path) ok(".env loaded", dotEnv.path);
  else info(".env", "not found");

  const pi = which(["pi"]);
  if (pi) ok("pi CLI", pi);
  else warn("pi CLI not found", "install @earendil-works/pi-coding-agent or use this as a package from pi");

  const ffmpeg = which(["ffmpeg"]);
  if (ffmpeg) ok("ffmpeg recorder", ffmpeg);
  else warn("ffmpeg recorder missing", "install ffmpeg or set MICME_RECORD_COMMAND");

  const configuredWhisperCpp = env("MICME_WHISPER_CPP_BIN");
  const whisperCpp = configuredWhisperCpp ? resolveExecutable(configuredWhisperCpp) : which(["whisper-cli", "whisper-cpp"]);
  const whisperCppModel = env("MICME_WHISPER_CPP_MODEL");
  if (whisperCpp && existsSync(whisperCpp)) ok("whisper.cpp binary", whisperCpp);
  else if (configuredWhisperCpp) warn("MICME_WHISPER_CPP_BIN is set but not found", configuredWhisperCpp);
  else warn("whisper.cpp binary missing", "recommended backend for portable local transcription");

  const configuredWhisperStream = env("MICME_WHISPER_STREAM_BIN");
  const whisperStream = configuredWhisperStream ? resolveExecutable(configuredWhisperStream) : which(["whisper-stream"]);
  if (whisperStream && existsSync(whisperStream)) ok("whisper-stream binary", whisperStream);
  else if (configuredWhisperStream) warn("MICME_WHISPER_STREAM_BIN is set but not found", configuredWhisperStream);
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
    const defaultModel = env("MICME_DEFAULT_WHISPER_CPP_MODEL") || "small.en";
    const modelDir = env("MICME_MODEL_DIR") || `${process.env.HOME}/.cache/whisper.cpp`;
    info("MICME_WHISPER_CPP_MODEL", `not set; Micme defaults to ${modelDir}/ggml-${defaultModel}.bin and auto-downloads when needed`);
  }

  const whisper = which(["whisper"]);
  if (whisper) ok("openai-whisper fallback", whisper);
  else info("openai-whisper fallback", "not installed");

  const transcribeCommand = env("MICME_TRANSCRIBE_COMMAND");
  if (transcribeCommand) ok("custom transcribe command", summarizeConfiguredCommand(transcribeCommand));
  else info("custom transcribe command", "not set");

  const recordCommand = env("MICME_RECORD_COMMAND");
  if (recordCommand) ok("custom record command", summarizeConfiguredCommand(recordCommand));
  else info("custom record command", "not set");

  console.log("\nRecommended macOS setup:");
  console.log("  brew install ffmpeg whisper-cpp");
  console.log("  # Then use /micme conf, or let Micme auto-download ggml-small.en.bin on first use.");

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
        warn("MacBook Pro microphone is not the configured default", `try: export MICME_AUDIO_DEVICE=${macbookMic[1]}`);
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
