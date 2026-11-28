import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { measureCases } from "./audio-quality.mjs";
import { wavDurationMs, wavHeader } from "./live-native/corpus.mjs";

const speech = { file: "speech.wav", language: "en", reference: "But now, but now!", audioMs: 2000 };
const rain = { file: "rain.wav", language: "en", reference: null, audioMs: 1000 };

function clock(...values) {
	return () => values.shift();
}

test("audio duration comes from complete 16 kHz PCM samples, not the WAV header bytes", () => {
	const payload = Buffer.alloc(32000);
	const wav = Buffer.concat([wavHeader(payload.length), payload]);
	assert.equal(wavDurationMs(wav, "example.wav"), 1000);
	assert.throws(() => wavDurationMs(wav.subarray(0, -2), "truncated.wav"), /canonical WAV: truncated\.wav/u);
});

test("a speech result reports Micme-normalized text, WER and wall time divided by audio duration", async () => {
	const { cases: [result] } = await measureCases([speech], async () => " But no\r\n now! ", clock(100, 600));
	assert.deepEqual(result, {
		...speech, transcript: "But no now!", elapsedMs: 500, realTimeFactor: 0.25,
		quality: { words: 4, substitutions: 1, deletions: 1, insertions: 0, wer: 0.5 },
	});
});

test("corpus WER and real-time factor are ratios of summed counts and durations", async () => {
	const short = { ...speech, reference: "Hello", audioMs: 1000 };
	const { summary } = await measureCases([short, speech], async (entry) => entry === short ? "Bye" : "But now, but now", clock(0, 500, 1000, 1500));
	assert.deepEqual(summary, {
		completedCases: 2, failedCases: 0, audioMs: 3000, elapsedMs: 1000, realTimeFactor: 1 / 3,
		speech: { cases: 2, words: 5, substitutions: 1, deletions: 0, insertions: 0, wer: 0.2 },
		nonSpeech: { cases: 0, withOutput: 0 },
	});
});

test("non-speech reports blank versus emitted text without treating a sound label as WER", async () => {
	const blank = { ...rain, file: "silence.wav" };
	const { cases, summary } = await measureCases([rain, blank], async (entry) => entry === rain ? "[rain falling]" : "  \n", clock(0, 50, 100, 150));
	assert.deepEqual(cases.map(({ transcript, quality }) => ({ transcript, ...quality })), [
		{ transcript: "[rain falling]", wer: null, emittedText: true, outputTokens: 2 },
		{ transcript: "", wer: null, emittedText: false, outputTokens: 0 },
	]);
	assert.equal(summary.speech.wer, null);
	assert.deepEqual(summary.nonSpeech, { cases: 2, withOutput: 1 });
});

test("a transcriber error remains visible and does not replace or skew later measurements", async () => {
	const failed = { ...speech, file: "failed.wav" };
	const { cases, summary } = await measureCases([failed, speech], async (entry) => {
		if (entry === failed) throw new Error("model load failed");
		return entry.reference;
	}, clock(0, 100, 300));
	assert.deepEqual(cases[0], { ...failed, error: "model load failed" });
	assert.equal(cases[1].quality.wer, 0);
	assert.equal(summary.failedCases, 1);
	assert.equal(summary.completedCases, 1);
	assert.equal(summary.audioMs, 2000);
	assert.equal(summary.elapsedMs, 200);
});

test("the quality command transcribes each fixture in its own language even if Pi is configured to translate", { skip: process.platform === "win32" && "requires a POSIX executable fixture" }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "micme-audio-quality-contract-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const cli = join(dir, "fake whisper-cli");
	const model = join(dir, "fake model.bin");
	await writeFile(join(dir, "micme.json"), JSON.stringify({ MICME_TRANSLATE_TO_ENGLISH: "de" }));
	await writeFile(model, "fake weights");
	await writeFile(cli, `#!/bin/sh
mode=transcribe
while [ "$#" -gt 0 ]; do
	case "$1" in
		-l) language="$2"; shift ;;
		-of) output="$2"; shift ;;
		-tr) mode=translate ;;
	esac
	shift
done
printf '%s %s\\n' "$mode" "$language" > "$output.txt"
`, { mode: 0o700 });

	const command = fileURLToPath(new URL("audio-quality.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [command, cli, model], {
		cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8", timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const cases = JSON.parse(result.stdout).cases;
	assert.equal(cases.length, 10);
	assert.deepEqual(Object.fromEntries(cases.filter(({ file }) => ["english-jfk.wav", "french-paris.wav", "russian-birthday.wav"].includes(file))
		.map(({ file, transcript }) => [file, transcript])), {
		"english-jfk.wav": "transcribe en",
		"french-paris.wav": "transcribe fr",
		"russian-birthday.wav": "transcribe ru",
	});
});
