// Opt-in contract checks, not a recognition benchmark. Set MICME_TEST_WHISPER_CPP_SOURCE
// to the pinned upstream source tree and put micme-live and CMake on PATH.
// Run: node --test test/native-decoder-contract.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const source = process.env.MICME_TEST_WHISPER_CPP_SOURCE;
let args;
before(() => {
	assert.ok(source, "Set MICME_TEST_WHISPER_CPP_SOURCE to the pinned whisper.cpp source tree.");
	// Upstream's ASR testing fixture has no trained weights: Silero and the worker
	// run normally, but Whisper provides no words. This deliberately exercises
	// the bounded empty-window recovery without asserting any model quality.
	args = ["--model", join(source, "models/for-tests-ggml-base.en.bin"),
		"--vad-model", join(source, "models/for-tests-silero-v6.2.0-ggml.bin"), "--language", "en"];
});
const finish = Buffer.of(3);

function feed(pcm, kind = 1) {
	const header = Buffer.alloc(5);
	header[0] = kind;
	header.writeUInt32LE(pcm.length / 2, 1);
	return Buffer.concat([header, pcm]);
}

function run(input, success = true) {
	return invoke("micme-live", args, input, success);
}

function invoke(binary, workerArgs, input, success) {
	const result = spawnSync(binary, workerArgs, { input, encoding: "utf8", timeout: 15_000 });
	assert.ifError(result.error);
	assert.equal(result.signal, null);
	assert.equal(result.status, success ? 0 : 1, result.stdout);
	assert.equal(result.stderr, "");
	const events = result.stdout.trimEnd().split("\n").map(JSON.parse);
	const [ready, ...rest] = events;
	assert.equal(ready.type, "ready");
	assert.equal(ready.version, 1);
	assert.equal(ready.rate, 16000);
	assert.equal(ready.asrLoads, 1);
	assert.equal(ready.vadLoads, 1);
	return rest;
}

function fixturePcm() {
	const wav = readFileSync(join(source, "samples/jfk.wav"));
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.toString("ascii", 8, 12), "WAVE");
	for (let offset = 12; offset + 8 < wav.length;) {
		const count = wav.readUInt32LE(offset + 4);
		if (wav.toString("ascii", offset, offset + 4) === "data") return wav.subarray(offset + 8, offset + 8 + count);
		offset += 8 + count + count % 2;
	}
	assert.fail("No public 16 kHz PCM fixture in the pinned upstream WAV.");
}

test("native silence skips ASR and the padded VAD tail never changes sample counts", () => {
	const events = run(Buffer.concat([feed(Buffer.alloc(32_000)), feed(Buffer.alloc(14), 2), finish]));
	assert.deepEqual(events.map(({ type }) => type), ["ack", "ack", "done"]);
	assert.equal(events[1].through, 16_007);
	assert.deepEqual(events[2], { type: "done", through: 16_007, asrCalls: 0, asrMs: 0, vadFrames: 32 });
});

for (const [name, input] of [
	["missing finish", Buffer.alloc(0)],
	["unknown frame type", Buffer.of(9)],
	["truncated count", Buffer.of(1, 1, 0)],
	["truncated PCM", Buffer.of(2, 2, 0, 0, 0, 0, 0)],
	["oversized count", Buffer.of(1, 0xff, 0xff, 0xff, 0xff)],
]) {
	test(`native ${name} fails instead of claiming success`, () => {
		const events = run(input, false);
		assert.deepEqual(events.map(({ type }) => type), ["error"]);
		assert.ok(events[0].message);
	});
}

test("native continuously open gate advances by exactly 20 seconds when ASR yields no times or text", () => {
	// Repeat the continuously spoken part, not the pauses in the full recording.
	const speech = fixturePcm().subarray(32_000 * 5.4, 32_000 * 7.3);
	const audio = Buffer.alloc(35 * 32_000);
	for (let i = 0; i < audio.length; i += speech.length) speech.copy(audio, i);
	const blocks = [];
	for (let i = 0; i < audio.length; i += 32_000) blocks.push(feed(audio.subarray(i, i + 32_000), 2));
	const events = run(Buffer.concat([...blocks, finish]));
	assert.equal(events.some(({ type }) => type === "partial"), false);
	const acks = events.filter(({ type }) => type === "ack");
	assert.equal(acks.length, 35);
	assert.ok(acks.every(({ through }, index) => through === (index + 1) * 16_000));
	const finals = events.filter(({ type }) => type === "final");
	const cut = finals.findIndex(({ from, to }) => to - from === 320_000);
	assert.ok(cut >= 0 && cut < finals.length - 1, `expected a bounded empty cut followed by later speech: ${JSON.stringify(finals)}`);
	assert.equal(finals[cut + 1].from, finals[cut].to);
	assert.ok(finals.every(({ from, text }, index) => text === "" && (index === 0 || from >= finals[index - 1].to)));
	const done = events.at(-1);
	assert.equal(done.type, "done");
	assert.equal(done.through, audio.length / 2);
	assert.equal(done.vadFrames, Math.ceil(done.through / 512));
	assert.equal(done.asrCalls, finals.length);
});

test("fresh Linux x64 builds select the tiled CPU kernels and honor an explicit opt-out", {
	skip: process.platform !== "linux" || process.arch !== "x64",
}, () => {
	const build = mkdtempSync(join(tmpdir(), "micme-native-cmake-"));
	const native = fileURLToPath(new URL("../native/live/", import.meta.url));
	try {
		for (const [value, flags] of [["ON", []], ["OFF", ["-DGGML_LLAMAFILE=OFF"]]]) {
			const result = spawnSync("cmake", ["-S", native, "-B", build, `-DFETCHCONTENT_SOURCE_DIR_WHISPERCPP=${source}`, ...flags],
				{ encoding: "utf8", timeout: 30_000 });
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
			const cache = readFileSync(join(build, "CMakeCache.txt"), "utf8");
			assert.equal(cache.match(/^GGML_LLAMAFILE:BOOL=(.*)$/m)?.[1], value);
		}
	} finally {
		rmSync(build, { recursive: true, force: true });
	}
});

let stub;
let stubDirectory;
after(() => {
	if (stubDirectory) rmSync(stubDirectory, { recursive: true, force: true });
});

function decoderWithStub() {
	if (stub) return stub;
	stubDirectory ??= mkdtempSync(join(tmpdir(), "micme-native-stub-"));
	const binary = join(stubDirectory, "micme-live-stub");
	const result = spawnSync("c++", [
		"-std=c++17", "-O2", "-pthread", "-I", join(source, "include"), "-I", join(source, "ggml/include"),
		fileURLToPath(new URL("../native/live/main.cpp", import.meta.url)),
		fileURLToPath(new URL("../native/live/decoder.cpp", import.meta.url)),
		fileURLToPath(new URL("native-decoder-stub.cpp", import.meta.url)), "-o", binary,
	], { encoding: "utf8", timeout: 30_000 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	stub = binary;
	return stub;
}

function voiced(samples, markers) {
	const pcm = Buffer.alloc(2 * samples);
	for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
	for (const [seconds, marker] of markers) pcm.writeInt16LE(marker, Math.round(seconds * 16_000) * 2);
	return pcm;
}

function frames(pcm, kind) {
	const chunks = [];
	for (let i = 0; i < pcm.length; i += 8_000) chunks.push(feed(pcm.subarray(i, i + 8_000), kind));
	return chunks;
}

function speak(fixture, success = true) {
	const pcm = voiced(success ? 21 * 16_000 + 7 : 20 * 16_000, [[0.55, 2000], [1.45, 3000], [18.7, 4000], [19.1, 4000]]);
	return invokeStub(fixture, Buffer.concat([...frames(pcm), ...(success ? [finish] : [])]), success);
}

test("timed words preview during uninterrupted speech and each side owns its repeated boundary word", () => {
	const events = speak("timed");
	const firstFinalIndex = events.findIndex(({ type }) => type === "final");
	const previews = events.slice(0, firstFinalIndex).filter(({ type }) => type === "partial");
	assert.deepEqual(previews.slice(0, 2).map(({ text }) => text.trim()), ["Grüß", "Grüß Okay."]);
	const finals = events.filter(({ type }) => type === "final");
	assert.equal(finals[0].to, 19 * 16_000);
	assert.deepEqual(events[firstFinalIndex + 1], { type: "partial", from: finals[0].to, to: 20 * 16_000, text: " encore" });
	assert.equal(finals[1].from, finals[0].to);
	assert.equal(finals[1].to, 21 * 16_000 + 7);
	assert.deepEqual(finals.map(({ text }) => text.trim()), ["Grüß Okay. encore", "encore"]);
	assert.equal(events.at(-1).through, finals[1].to);
});

test("a short endpoint uses native encoder context even when no preview ran", () => {
	const pcm = voiced(16_000, [[0.55, 2000]]);
	const events = invokeStub("endpoint", Buffer.concat([...frames(pcm, 2), finish]), true);
	assert.equal(events.some(({ type }) => type === "partial"), false);
	assert.equal(events.find(({ type }) => type === "final").text.trim(), "Grüß");
	assert.equal(events.at(-1).through, 16_000);
});

test("the first preview after backlog uses recent audio without discarding the onset from finals", () => {
	const pcm = voiced(15 * 16_000, [[0.55, 2000], [14.6, 3000]]);
	const input = Buffer.concat([...frames(pcm.subarray(0, -8000), 2), feed(pcm.subarray(-8000)), finish]);
	const events = invokeStub("timed", input, true);
	const partials = events.filter(({ type }) => type === "partial");
	assert.equal(partials.length, 1);
	assert.ok(partials[0].from > 0);
	assert.equal(partials[0].text.trim(), "Okay.");
	assert.equal(events.find(({ type }) => type === "final").text.trim(), "Grüß Okay.");
	assert.equal(events.at(-1).through, 15 * 16_000);
});

test("a weak draft suffix is deferred until the same words recur at the same times", () => {
	const pcm = voiced(4 * 16_000, [[0.25, 2000], [0.55, 3000], [2.25, 4000]]);
	const events = invokeStub("draft-agreement", Buffer.concat([...frames(pcm), finish]), true);
	const drafts = events.filter(({ type }) => type === "partial");
	assert.deepEqual(drafts.slice(0, 3).map(({ text }) => text.trim()), ["Grüß Okay.", "Grüß Okay.", "Grüß Okay. encore"]);
	assert.equal(events.find(({ type }) => type === "final").text.trim(), "Grüß Okay. encore");
});

test("a confident newer word doesn't validate an uncertain interior word at the draft edge", () => {
	const pcm = voiced(4 * 16_000, [[0.25, 2000], [0.55, 3000], [1.3, 4000], [1.7, 5000]]);
	const events = invokeStub("draft-edge", Buffer.concat([...frames(pcm), finish]), true);
	assert.deepEqual(events.filter(({ type }) => type === "partial").slice(0, 3).map(({ text }) => text.trim()),
		["Grüß Okay.", "Grüß Okay.", "Grüß Okay. encore here"]);
	assert.equal(events.find(({ type }) => type === "final").text.trim(), "Grüß Okay. encore here");
});

test("a brief pause can anchor a preview without splitting or truncating the final span", () => {
	const pcm = voiced(11.5 * 16_000, [[5.6, 2000], [9.27, 3000]]);
	const quietFrom = 155 * 512;
	const quietTo = quietFrom + 7 * 512;
	pcm.fill(0, 2 * quietFrom, 2 * quietTo);
	const events = invokeStub("timed", Buffer.concat([...frames(pcm), finish]), true);
	assert.ok(events.some(({ type, from, text }) => type === "partial" && quietFrom < from && from < quietTo && text.trim() === "Grüß Okay."));
	assert.deepEqual(events.filter(({ type }) => type === "final").map(({ text }) => text.trim()), ["Grüß Okay."]);
});

test("light previews keep their acoustic start across updates without losing earlier words from the final", () => {
	const pcm = voiced(11 * 16_000, [[0.55, 2000], [8.5, 3000], [9.5, 4000]]);
	const quietFrom = 96 * 512;
	const quietTo = quietFrom + 4 * 512;
	pcm.fill(0, 2 * quietFrom, 2 * quietTo);
	const events = invokeStub("light-anchor", Buffer.concat([...frames(pcm), finish]), true);
	const anchored = events.filter(({ type, from }) => type === "partial" && from > quietFrom && from < quietTo);
	assert.ok(anchored.length >= 2);
	assert.equal(new Set(anchored.map(({ from }) => from)).size, 1);
	assert.ok(anchored.some(({ text }) => text.trim() === "Okay. encore"));
	assert.deepEqual(events.filter(({ type }) => type === "final").map(({ text }) => text.trim()), ["Grüß Okay. encore"]);
	assert.equal(events.at(-1).through, pcm.length / 2);
});

test("a resumed endpoint uses the previous final as context without replaying it", () => {
	const pcm = voiced(4 * 16_000, [[0.4, 5000], [0.8, 6000], [2.5, 9000]]);
	pcm.fill(0, 2 * 16_000, 4 * 16_000);
	const events = invokeStub("pause", Buffer.concat([...frames(pcm), finish]), true);
	const finals = events.filter(({ type }) => type === "final");
	assert.deepEqual(finals.map(({ text }) => text.trim()), ["here we", "go"]);
	assert.ok(finals[0].to < finals[1].from);
	assert.ok(events.filter(({ type, from }) => type === "partial" && from === finals[1].from)
		.some(({ text }) => text.trim() === "went"), "drafts must not use the confirmed prompt");
	assert.equal(events.at(-1).through, pcm.length / 2);
});

test("an endpoint after a long pause starts without the previous prompt", () => {
	const pcm = voiced(7 * 16_000, [[0.4, 5000], [0.8, 6000], [5.5, 9000]]);
	pcm.fill(0, 2 * 16_000, 10 * 16_000);
	const events = invokeStub("pause", Buffer.concat([...frames(pcm, 2), finish]), true);
	assert.deepEqual(events.filter(({ type }) => type === "final").map(({ text }) => text.trim()), ["here we", "went"]);
});

test("rollover reconciles shifted word times without removing a real repeated phrase", () => {
	const pcm = voiced(20.75 * 16_000, [[18.45, 5000], [18.65, 6000], [18.91, 7000], [19.05, 8000],
		[19.45, 5000], [19.65, 6000], [19.91, 7000]]);
	const input = Buffer.concat([...frames(pcm, 2), finish]);
	for (const fixture of ["seam-earlier", "seam-later"]) {
		const events = invokeStub(fixture, input, true);
		const finals = events.filter(({ type }) => type === "final");
		assert.deepEqual(finals.map(({ text }) => text.trim()), ["here we go", "again here we go"], fixture);
		assert.equal(finals[1].from, finals[0].to);
		assert.equal(events.at(-1).through, pcm.length / 2);
	}
});

test("nonempty untimed output cannot be finalized as an invented rollover partition", () => {
	const events = speak("untimed", false);
	assert.equal(events.some(({ type }) => type === "final" || type === "done"), false);
	assert.match(events.at(-1).message, /could not place words at the live window limit/i);
});

function invokeStub(fixture, input, success) {
	return invoke(decoderWithStub(), ["--model", fixture, "--vad-model", "vad", "--language", "en"], input, success);
}

test("inference errors are not successful no-word decodes", () => {
	const pcm = Buffer.alloc(32_000, 1);
	const events = invokeStub("fail-inference", Buffer.concat([feed(pcm), feed(pcm.subarray(0, 1024))]), false);
	assert.equal(events.at(-1).type, "error");
	assert.match(events.at(-1).message, /ASR inference failed/);
});
