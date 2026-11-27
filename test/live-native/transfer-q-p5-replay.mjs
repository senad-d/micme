// Opt-in P5 measurement only; see transfer-q-p5-evidence.md for the fixed public inputs.
import assert from "node:assert/strict";
import { closeSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, release, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { recognizeFile } from "../../src/transfer/recognition.ts";
import { RATE, sha256 } from "./corpus.mjs";
import { pcmFromWav } from "./transfer-fixtures.mjs";
import { validateTake } from "./transfer-schema.mjs";
import { wordErrors } from "./scoring.mjs";

const binaryDigest = "40e7b2cd455c9a4fc8e412da781492f73b08be0d6557207ba2e6f20e83657413";
const baseDigest = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
const smallDigest = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const fr = { path: "p5-french.wav", sha: "87a736dd946fe669c487ee610116bf85ce4c6abd0f7efac2d106c45a6b7459a5", language: "fr",
	reference: "Les plages sont nombreuses, car Auckland est à cheval sur deux ports. Les plus populaires se trouvent dans trois zones." };
const zh = { path: "p5-chinese.wav", sha: "d7849dceb3c233d3165c0b960cb5882183ade854588a5b00c26574cbb6284d22", language: "zh",
	reference: "在这个迷人的村庄漫步半小时是值得的。" };
const traditionalReference = "在這個迷人的村莊漫步半小時是值得的。";
const negatives = [
	["repeat", "2b8f625d3bd51d75aca1e06110c1eaaec33414bfe90000f988a9d95f5c618117", "but now but now it doesn't seem to matter very much"],
	["silence", "ac2878215ad33205d1732578c89f25ededaad1b676911c540825bcf4baa42d9b", ""],
	["noise", "823579e8c8818ee99f87e6fa4d38f4f939305bec6248c619b4af3550aaf022c1", ""],
];
const transcribe = { task: "transcribe", options: {} };
const wordRules = { MICME_WORDS: '["Auckland","José","Boston"]', MICME_REMOVE_FILLERS: "1", MICME_FILLERS: '["hesitation mark"]' };
const cases = [
	{ ...transcribe, ...fr, fixture: "french", panel: "off" },
	{ ...transcribe, ...fr, fixture: "french", panel: "on", options: wordRules },
	{ ...fr, fixture: "translation", panel: "off", task: "translate-en", options: {},
		reference: "There are many beaches, due to Auckland's straddling of two harbours. The most popular ones are in three areas." },
	{ ...transcribe, ...zh, fixture: "nonlatin", panel: "off" },
	...["simplified", "taiwan", "hong-kong"].map((form) => ({ ...transcribe, ...zh, fixture: "nonlatin", panel: form,
		options: { ...wordRules, MICME_SCRIPT: form }, reference: form === "simplified" ? zh.reference : traditionalReference })),
	...negatives.flatMap(([fixture, sha, reference]) => ["off", "on"].map((panel) => ({ ...transcribe, fixture, sha, reference, language: "en",
		path: `${fixture}.wav`, panel, options: panel === "off" ? {} : wordRules }))),
];

function publicAudio(wav) {
	return { bytes: wav.length, sha256: sha256(wav), copyTo: async (dir) => {
		const path = join(dir.filesPath, "public.wav");
		const fd = dir.createPrivateFile(path);
		try { writeFileSync(fd, wav); } finally { closeSync(fd); }
		return path;
	} };
}

function takeFacts(setup, build, pcm) {
	const rig = { os: release(), arch: arch(), display: "headless", cpu: cpus()[0]?.model ?? null, gpu: null, driver: null,
		actualBackend: "unknown", actualDevice: null, requestedDevice: "cpu", threads: null, mic: null, hostVersion: null };
	const { panel, fixture, language, task, reference } = setup;
	return { trial: { version: 1, pairId: `p5-${fixture}-${panel}`, repeatIndex: 0, product: build.product, track: "pcm", panel: "matched", fixture,
		pcmSha256: sha256(pcm), referenceText: reference, language, task, rig, build, width: null, target: "none", prefix: null,
		cache: "cold-process", disk: "unknown", load: "idle", processing: panel === "off" ? "off" : "on", input: "file", gesture: "none" },
		native: null, outcome: "completed", gaps: [{ stage: null, code: "no-observer", detail: "File route has no native ASR call/alignment observer in this P5 experiment." }],
		events: [{ stage: "trigger", ms: 0 }], visible: [], commits: [], mutations: [], expectedTarget: null, observedTarget: null,
		raw: null, cleaned: null, replayed: null, delivered: null, sentCount: null, queuedCount: null,
		pcmBytes: pcm.length, fedBytes: null, fedSha256: null, computeMs: null, audioMs: pcm.length / 2 / RATE * 1_000,
		peakLagSamples: null, peakRssBytes: null, idleRssBytes: null, idleMicOpen: null, missedOnset: null, missedTail: null,
		repeatErrors: null, staleInsertions: null, duplicateInsertions: null };
}

function chars(text) { return (text.normalize("NFC").match(/[\p{L}\p{M}\p{N}]/gu) ?? []).join(" "); }

function errors(setup, text) {
	if (setup.task === "translate-en") return null; // Not a translation quality metric.
	const character = setup.language === "zh";
	const { words: referenceUnits, wer: rate, ...counts } = character ? wordErrors(chars(setup.reference), chars(text)) : wordErrors(setup.reference, text);
	return { metric: character ? "cer" : "wer", referenceUnits, ...counts, rate };
}

async function sample(setup, binary, model, file, work, build) {
	const wav = await readFile(file);
	const pcm = pcmFromWav(wav);
	assert.equal(sha256(pcm), setup.sha, `Unexpected PCM: ${setup.fixture}`);
	process.env = { HOME: work, TMPDIR: work, PI_CODING_AGENT_DIR: work, MICME_WHISPER_CPP_BIN: binary, MICME_WHISPER_CPP_MODEL: model,
		MICME_PREFERRED_LANGUAGES: '["ja","en"]', ...setup.options };
	const take = takeFacts(setup, build, pcm);
	const started = performance.now();
	const choice = { variantId: model, compute: "cpu", requestedDeviceId: null, language: setup.language, task: setup.task, chunking: false, detector: "off" };
	try {
		const result = await recognizeFile(publicAudio(wav), choice, "cli", () => {}, AbortSignal.timeout(60_000));
		take.events.push({ stage: "rawFinal", ms: performance.now() - started });
		take.trial.rig.actualBackend = result.actualCompute;
		take.trial.rig.actualDevice = result.boundDevice;
		take.raw = result.raw;
		take.cleaned = result.local;
		return { take, result: { rules: result.rules, rawErrors: errors(setup, result.raw), localErrors: errors(setup, result.local) } };
	} catch (error) {
		console.error(`${setup.fixture} / ${setup.panel}: ${error.message}`);
		take.outcome = "failed";
		take.gaps.push({ stage: "rawFinal", code: "no-result", detail: "The installed local Whisper file route returned no final in this attempt." });
		return { take, result: null };
	}
}

async function replay(binary, model, fleurs, p1, traces, scores) {
	assert.equal(sha256(await readFile(binary)), binaryDigest, "Expected the pinned CPU whisper-cli build");
	const modelDigest = sha256(await readFile(model));
	assert.ok(modelDigest === baseDigest || modelDigest === smallDigest, "Expected the pinned multilingual base or small model");
	const selected = modelDigest === baseDigest ? cases : cases.filter(({ fixture }) => fixture === "translation" || fixture === "french");
	const build = { product: "micme-current", tag: null, commit: null, binarySha256: binaryDigest,
		engineRevision: "96ec4d9823e9d0211944172da35f9f29134af990", backend: "whisper.cpp", modelRevision: "5359861c739e955e79d9a303bcbc70fb988958b1",
		modelFile: basename(model), modelSha256: modelDigest, quant: "F16", vad: "off", chunkPolicy: "bounded file route (one chunk for all P5 fixtures)" };
	await writeFile(traces, "", { flag: "wx" });
	const work = await mkdtemp(join(tmpdir(), "micme-p5-"));
	const originalDirectory = process.cwd();
	const results = [];
	try {
		process.chdir(work);
		for (const setup of selected) {
			const directory = setup.language === "en" ? p1 : fleurs;
			const { take, result } = await sample(setup, binary, model, join(directory, setup.path), work, build);
			await appendFile(traces, `${JSON.stringify(validateTake(take))}\n`, "utf8");
			results.push({ line: results.length + 1, fixture: setup.fixture, panel: setup.panel, options: setup.options, ...result });
			if (!result) process.exitCode = 1;
		}
		await writeFile(scores, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`, { flag: "wx" });
	} finally {
		process.chdir(originalDirectory);
		await rm(work, { recursive: true, force: true });
	}
}

const argv = process.argv.slice(2);
if (argv.length !== 6) throw new Error("Usage: transfer-q-p5-replay.mjs WHISPER_CLI BASE_OR_SMALL_MODEL FLEURS_WAV_DIR P1_WAV_DIR TAKE_JSONL SCORE_JSONL");
await replay(...argv.map((path) => resolve(path)));
