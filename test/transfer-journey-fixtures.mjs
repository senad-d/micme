import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellQuote } from "../src/processes.ts";

export const publicText = "Public specimen words.";
export const zeros = Buffer.alloc(1_536);
export const voiced = Buffer.alloc(2_048, 29);
export const middle = Buffer.alloc(1_024, 52);
export const tail = Buffer.alloc(2_560, 71);
export const fullInput = Buffer.concat([voiced, tail]);

export function wavHeader(bytes) {
	const header = Buffer.from("524946462400000057415645666d74201000000001000100803e0000007d0000020010006461746100000000", "hex");
	header.writeUInt32LE(36 + bytes, 4);
	header.writeUInt32LE(bytes, 40);
	return header;
}

export function wav(pcm) {
	return Buffer.concat([wavHeader(pcm.length), pcm]);
}

export function sha(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

// Copied exactly from "stopping a custom clip recorder that exits 255 pastes its transcript"
// in extension-lifecycle.test.mjs. In particular it does not open the WAV until SIGINT.
const closeOnlySource = `import { writeFileSync } from "node:fs";
const [audio, ready] = process.argv.slice(2);
process.on("SIGINT", () => {
  // Mono 16-bit PCM WAV header followed by 1024 bytes of samples.
  const header = Buffer.from("524946462404000057415645666d74201000000001000100803e0000007d0000020010006461746100040000", "hex");
  writeFileSync(audio, Buffer.concat([header, Buffer.alloc(1024, 32)]));
  process.exit(255);
});
writeFileSync(ready, "ready");
setInterval(() => {}, 1_000);
`;

const childImports = `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const control = JSON.parse(readFileSync(join(root, "control.json"), "utf8"));
const log = (kind, data = {}) => appendFileSync(join(root, "fixture.jsonl"), JSON.stringify({ kind, ...data }) + "\\n");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const has = (name) => existsSync(join(root, name));
`;

const captureSource = `
let audio, timer, header = false, block = false, followup = false, stopping = false;
function requestStop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  log("stopGesture", { reason: "recorder-stop" });
  if (!control.holdDrain) return finish();
  timer = setInterval(() => { if (has("release-drain")) finish(); }, 10);
}
function finish() {
  clearInterval(timer);
  const pcm = control.pcm === "zero" ? zeros : control.pcmByte ? Buffer.alloc(voiced.length, control.pcmByte) : voiced;
  const ending = control.pcm === "zero" && control.allZero ? Buffer.alloc(tail.length) : tail;
  let payload = Buffer.concat(followup ? [pcm, middle, ending] : [pcm, ending]);
  if (control.damage === "prefix") payload = Buffer.concat([Buffer.alloc(pcm.length, 43), ending]);
  if (control.damage === "replace") renameSync(audio, audio + ".original");
  if (control.damage === "invalid") writeFileSync(audio, "RIFF but no valid WAV".repeat(40));
  else writeFileSync(audio, wav(payload));
  log("drained", { bytes: payload.length, pcmSha256: sha(payload) });
  process.exit(0);
}
function poll() {
  if (has("unplug")) {
    process.stderr.write("Fixture microphone disconnected: no such input device\\n", () => process.exit(42));
    clearInterval(timer);
    return;
  }
  if (!header && (!control.gated || has("header"))) {
    writeFileSync(audio, wavHeader(0));
    header = true;
    log("header");
  }
  if (header && !block && (!control.gated || has("block"))) {
    appendFileSync(audio, control.pcm === "zero" ? zeros : control.pcmByte ? Buffer.alloc(voiced.length, control.pcmByte) : voiced);
    block = true;
    log("block");
  }
  if (control.followup && block && !followup && has("followup")) {
    appendFileSync(audio, middle);
    followup = true;
    log("followup");
  }
}
if (args.includes("-sources") || args.includes("-list_devices")) {
  const pulse = "Auto-detected sources for pulse:\\n* public-mic [Fixture input]\\n  other-mic [Different input]\\n";
  const av = "[AVFoundation indev @ fixture] AVFoundation audio devices:\\n[AVFoundation indev @ fixture] [2] Fixture input\\n";
  process.stderr.write(args.includes("-sources") ? pulse : av);
} else if (args.includes("volumedetect")) {
  process.stderr.write("[Parsed_volumedetect_0 @ fixture] max_volume: " + (control.pcm === "zero" ? "-91.0" : "-12.0") + " dB\\n");
} else if (args.at(-1)?.endsWith(".wav") && args.includes("-i") && ["pulse", "avfoundation"].includes(args[args.indexOf("-f") + 1])) {
  audio = args.at(-1);
  process.on("SIGINT", requestStop);
  process.stdin.on("data", (data) => { if (data.includes(113)) requestStop(); });
  log("trigger", { role: "recorder", input: args[args.indexOf("-i") + 1] });
  timer = setInterval(poll, 10);
} else if (args.at(-1)?.endsWith(".wav") && args.includes("-i") && !args.includes("-af")) {
  // Identity conversion for an explicitly imported, already canonical local fixture.
  const bytes = readFileSync(args[args.indexOf("-i") + 1]);
  writeFileSync(args.at(-1), bytes);
  log("conversion", { digest: sha(bytes) });
} else {
  throw new Error("Unexpected fixture ffmpeg invocation: " + JSON.stringify(args));
}
`;

const workerSource = `
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
log("modelLoaded", { role: "worker", pid: process.pid, args });
send({ type: "ready", version: 1, rate: 16000, loadMs: 0, asrLoads: 1, vadLoads: 1 });
let pending = Buffer.alloc(0), through = 0;
let heardVoice = false;
if (control.worker === "no-ack") {
  const timer = setInterval(() => {
    if (!has("bad-done")) return;
    clearInterval(timer);
    log("premature-done", { through });
    send({ type: "done", through, asrCalls: 1, asrMs: 0, vadFrames: 2 });
  }, 10);
  process.on("SIGINT", () => {
    send({ type: "final", from: 0, to: through, text: "Stale result after cancel." });
    process.exit(0);
  });
}
process.stdin.on("data", (part) => {
  pending = Buffer.concat([pending, part]);
  while (pending.length) {
    if (pending[0] === 3) {
      log("finish", { through });
      if (heardVoice) send({ type: "final", from: 0, to: through, text: control.text });
      log("done", { through, asrCalls: Number(heardVoice) });
      return process.stdout.write(JSON.stringify({ type: "done", through, asrCalls: Number(heardVoice), asrMs: 0, vadFrames: 2 }) + "\\n", () => process.exit(0));
    }
    if (pending.length < 5) return;
    assert.ok(pending[0] === 1 || pending[0] === 2);
    const samples = pending.readUInt32LE(1);
    const end = 5 + samples * 2;
    if (pending.length < end) return;
    const pcm = pending.subarray(5, end);
    pending = pending.subarray(end);
    log("feed", { from: through, through: through + samples, pcmSha256: sha(pcm) });
    through += samples;
    heardVoice ||= !control.noSpeech && pcm.some(Boolean);
    if (control.worker === "no-ack") {
      if (heardVoice) send({ type: "final", from: 0, to: through, text: "Do not release an unacknowledged span." });
      return;
    }
    log("ack", { through });
    send({ type: "ack", through });
  }
});
`;

const clipSource = `
const option = (key) => args[args.indexOf(key) + 1];
if (args.includes("--help") || args.includes("-h") || args.includes("--version")) {
  console.log("whisper-cli public fixture -m MODEL -f FILE -l LANGUAGE -tr -otxt -of OUTPUT");
} else {
  const bytes = readFileSync(option("-f"));
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  assert.equal(bytes.readUInt32LE(40) + 44, bytes.length);
  log("clip", { model: option("-m"), language: args.includes("-l") ? option("-l") : null, translate: args.includes("-tr"),
    digest: sha(bytes), pcmSha256: sha(bytes.subarray(44)), bytes: bytes.length });
  if (control.failAsr) {
    process.stderr.write("fixture decoder could not recognize input\\n", () => process.exit(17));
  } else {
    writeFileSync(option("-of") + ".txt", control.text + "\\n");
  }
}
`;

const playerSource = `
const inputIndex = args.indexOf("-i");
const input = args[inputIndex + 1];
assert.ok(inputIndex >= 0 && input && existsSync(input), "player did not receive a verified WAV: " + JSON.stringify(args));
const bytes = readFileSync(input);
log("play", { digest: sha(bytes), bytes: bytes.length });
`;

export const fixtureInput = process.platform === "darwin" ? ":2" : "public-mic";

function executable(root, code) {
	return `#!${process.execPath}\nconst root = ${JSON.stringify(root)};\n${childImports}\n${wavHeader}\n${wav}\n` +
		`const zeros = Buffer.from("${zeros.toString("base64")}", "base64");\nconst voiced = Buffer.from("${voiced.toString("base64")}", "base64");\n` +
		`const tail = Buffer.from("${tail.toString("base64")}", "base64");\nconst middle = Buffer.from("${middle.toString("base64")}", "base64");\n${code}`;
}

export async function fixtures(root) {
	const agent = join(root, "agent");
	const project = join(root, "project");
	const bin = join(root, "bin");
	const models = join(root, "models");
	const spool = join(root, "spool");
	await Promise.all([agent, project, bin, models, spool].map((dir) => mkdir(dir, { mode: 0o700 })));
	const model = join(models, "ggml-base.bin");
	const whisper = join(bin, "whisper-cli");
	const worker = join(bin, "micme-live");
	const vad = join(models, "public-vad.bin");
	const sample = join(project, "public-sample.wav");
	const hookReady = join(root, "sigint-handler-ready");
	const recorder = join(root, "close-only.mjs");
	await Promise.all([
		writeFile(model, "public fixture, not weights"), writeFile(vad, "public fixture, not weights"),
		writeFile(sample, wav(fullInput)), writeFile(recorder, closeOnlySource),
		writeFile(whisper, executable(root, clipSource), { mode: 0o700 }),
		writeFile(worker, executable(root, workerSource), { mode: 0o700 }),
		writeFile(join(bin, "ffmpeg"), executable(root, captureSource), { mode: 0o700 }),
		symlink("/bin/sh", join(bin, "sh")),
		...["ffplay", "afplay", "paplay", "aplay", "play"].map((name) => writeFile(join(bin, name), executable(root, playerSource), { mode: 0o700 })),
	]);
	const closeOnly = `exec ${shellQuote(process.execPath)} ${shellQuote(recorder)} {audio} ${shellQuote(hookReady)}`;
	const settings = {
		MICME_WHISPER_CPP_MODEL: model, MICME_WHISPER_CPP_BIN: whisper, MICME_MODEL_DIR: models,
		MICME_LIVE_BIN: worker, MICME_VAD_MODEL: vad, MICME_AUTO_DOWNLOAD_MODEL: "0",
		MICME_TRANSCRIPTION_MODE: "clip", MICME_TRANSCRIBE_BACKEND: "auto", MICME_LANGUAGE: "fr", MICME_TRANSLATE_TO_ENGLISH: "off",
		MICME_PROCESS_AUDIO: "0", MICME_VALIDATE_AUDIO: "0", MICME_KEEP_AUDIO: "0", MICME_AUTO_SUBMIT: "0", MICME_PRINTABLE_SHORTCUTS: "",
		MICME_RECORD_METER: "0", MICME_TRANSCRIBE_TIMEOUT_MS: "6000", MICME_PULSE_SOURCE: "public-mic", MICME_AVFOUNDATION_INPUT: ":2",
	};
	const configPath = join(agent, "micme.json");
	return {
		root, agent, project, bin, spool, model, whisper, sample, hookReady, closeOnly, configPath, settings,
		configure: (overrides) => writeFile(configPath, JSON.stringify({ ...settings, ...overrides }), { mode: 0o600 }),
		control: (state) => writeFile(join(root, "control.json"), JSON.stringify({ text: publicText, ...state })),
		gate: (name) => writeFile(join(root, name), "on"),
		reset: () => Promise.all(["fixture.jsonl", "header", "block", "followup", "unplug", "bad-done", "release-drain", "sigint-handler-ready"].map((name) => rm(join(root, name), { force: true }))),
	};
}

export async function events(root, kind) {
	const text = await readFile(join(root, "fixture.jsonl"), "utf8").catch(ignoreMissing(""));
	return text.trim().split("\n").filter(Boolean).map(JSON.parse).filter((row) => !kind || row.kind === kind);
}

export function ignoreMissing(fallback) {
	return (error) => {
		if (error.code !== "ENOENT") throw error;
		return fallback;
	};
}

export async function files(root, extension) {
	const names = await readdir(root, { recursive: true }).catch(ignoreMissing([]));
	return names.filter((name) => !extension || name.endsWith(extension)).sort().map((name) => join(root, name));
}
