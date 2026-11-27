import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256, wavHeader } from "./live-native/corpus.mjs";
import { pcmFromWav, readFixture } from "./live-native/transfer-fixtures.mjs";
import { generateReport, SCORECARD_INPUTS, scoreTake, summarize, writeTransferReport } from "./live-native/transfer-report.mjs";
import { emptyTake, interleaveTrials, runTransfer } from "./live-native/transfer-runner.mjs";
import { readJsonl, validateProtocol, validateScorecardRow, validateTake } from "./live-native/transfer-schema.mjs";

const hash = "a".repeat(64);
const rig = { os: "linux", arch: "x64", display: null, cpu: "fixture cpu", gpu: null, driver: null, actualBackend: "cpu",
	actualDevice: { id: "cpu0", label: "Observed CPU" }, requestedDevice: "cpu", threads: 2, mic: null, hostVersion: "public host" };

function build(product = "micme-current", commit = hash.slice(0, 40)) {
	return { product, tag: null, commit, binarySha256: hash, engineRevision: "engine", backend: "worker", modelRevision: "weights",
		modelFile: "test-model.bin", modelSha256: hash, quant: "f16", vad: "off", chunkPolicy: "off" };
}

function plan(artifact = build(), repeatIndex = 0, settings = {}) {
	return { version: 1, pairId: "frozen-pair", repeatIndex, product: artifact.product, track: "pcm", panel: "matched", fixture: "short",
		pcmSha256: hash, referenceText: "thank you", language: "en", task: "transcribe", rig, build: artifact, width: null, target: "none",
		prefix: null, cache: "cold-process", disk: "cached", load: "idle", processing: "off", input: "file", gesture: "none", ...settings };
}

function cpms(trial, finalMs = 100) {
	const { gaps, ...skip } = emptyTake(trial, "completed", "no-result", "Unused");
	assert.equal(gaps.length, 1);
	return { ...skip, gaps: [], events: [{ stage: "modelLoaded", ms: -1 }, { stage: "trigger", ms: 0 }, { stage: "rawFinal", ms: finalMs }],
		pcmBytes: 32_000, fedBytes: 32_000, fedSha256: hash, computeMs: 50, audioMs: 1_000, peakLagSamples: 0, peakRssBytes: 8_000,
		idleRssBytes: 7_000, raw: trial.referenceText,
		native: { route: "batch", asrCalls: trial.fixture === "silence" ? 0 : 1, asrLoads: 1, vadLoads: 0, capturedSamples: 16_000,
			closedSamples: 16_000, inputSamples: 16_000, inputPcmSha256: hash, wire: null, endpoints: [], chunks: null,
			matchedClipRaw: trial.referenceText, alignedWords: [], onsetMs: 0, endMs: 1_000, workerCleanExit: true } };
}

function streamTrace() {
	const referenceText = "but now it matters very much in eighteen sixty three";
	const trial = plan(build(), 0, { fixture: "continuous", referenceText, track: "destination", input: "loopback", target: "pi-prompt",
		width: 40, prefix: "draft: ", gesture: "toggle" });
	const take = cpms(trial, 9_500);
	const frames = ["but now", "but now it matters", "but now it matters very much", "…it matters very much in eighteen", "…very much in eighteen sixty three"];
	take.visible = frames.map((text, i) => ({ ms: [1_300, 2_900, 4_500, 6_200, 8_300][i], text: `Live: ${text}` }));
	const target = trial.prefix + referenceText;
	return { ...take,
		native: { ...take.native, route: "stream", alignedWords: referenceText.split(" ").map((word, index) => ({ word, endMs: 400 + 800 * index })),
			onsetMs: 100, endMs: 8_500, endpoints: [{ ms: 9_000, text: referenceText }],
			wire: [{ kind: "feed", from: 0, through: 10_000, catchUp: false }, { kind: "ack", through: 10_000 },
				{ kind: "feed", from: 10_000, through: 16_000, catchUp: false }, { kind: "ack", through: 16_000 }, { kind: "finish" }, { kind: "done", through: 16_000 }] },
		events: [...take.events.slice(0, 2), { stage: "firstSample", ms: 1 }, { stage: "readyCue", ms: 15 }, { stage: "speechOnset", ms: 100 },
			{ stage: "speechEnd", ms: 8_500 }, { stage: "stopGesture", ms: 8_700 }, { stage: "firstEndpoint", ms: 9_000 }, { stage: "firstCommit", ms: 9_100 },
			{ stage: "drained", ms: 9_300 }, take.events.at(-1), { stage: "correctTarget", ms: 9_700 }],
		commits: [{ ms: 9_100, text: referenceText }], mutations: [{ ms: 9_700, text: target }], expectedTarget: target, observedTarget: target,
		delivered: referenceText, sentCount: 0, queuedCount: 0, staleInsertions: 0, duplicateInsertions: 0, repeatErrors: 0, missedOnset: false, missedTail: false, idleMicOpen: false,
	};
}

function protocol(products, trials) {
	return { version: 1, products, trials, calibration: [], toleranceMs: [], minimumTimed: 20, createdUtc: "2026-11-27T00:00:00Z" };
}

function qrow(phase, artifact, takes = [], before = []) {
	return { version: 1, phase, feature: phase === 1 ? "BASE" : "C1", build: artifact, rig: null, language: null, task: null, target: null,
		cache: null, fixture: null, provider: null, check: takes.length ? "pass" : "blocked", label: takes.length ? "existing-verified" : "blocked",
		reason: takes.length ? null : "No real host observation; supply an isolated receiver trace.", evidence: [], takes, before };
}

async function workspace(t) {
	const dir = await mkdtemp(join(tmpdir(), "transfer-protocol-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

const writeJson = (dir, name, value) => writeFile(join(dir, name), `${JSON.stringify(value)}\n`);
const writeRows = (dir, name, values) => writeFile(join(dir, name), values.map((row) => `${JSON.stringify(row)}\n`).join(""));

function takeRefs(file, count, start = 1) {
	return Array.from({ length: count }, (_, i) => ({ file, line: start + i }));
}

async function bundle(t, count = 20) {
	const root = await workspace(t);
	const ref = build("micme-70ad138");
	const candidate = build();
	const a = Array.from({ length: count }, (_, i) => plan(ref, i));
	const b = Array.from({ length: count }, (_, i) => plan(candidate, i));
	const frozen = protocol([ref, candidate], [...a, ...b]);
	frozen.calibration = [cpms(plan(ref, 0), 100), cpms(plan(ref, 1), 102)];
	frozen.toleranceMs = [{ from: "trigger", to: "rawFinal", ms: 2 }];
	const file = "transfer-q-p1-takes.jsonl";
	await writeJson(root, "transfer-p1-manifest.json", frozen);
	await writeRows(root, file, [...a.map((slot) => cpms(slot)), ...b.map((slot) => cpms(slot, 101))]);
	await writeRows(root, SCORECARD_INPUTS[0], [qrow(1, ref, takeRefs(file, count)), qrow(1, candidate, takeRefs(file, count, count + 1))]);
	return { root, frozen, file, a, b };
}

test("silence with identical PCM and empty final fails the zero-inference gate after one ASR call", () => {
	const take = cpms(plan(build(), 0, { fixture: "silence", referenceText: "" }));
	assert.equal(scoreTake(take).status, "pass");
	take.native.asrCalls = 1;
	assert.equal(scoreTake(take).gates.silenceCalls.state, "fail");
});

test("mismatched ACKs and overlapping feeds fail despite identical end totals and final text", () => {
	const take = streamTrace();
	assert.equal(scoreTake(take).gates.wire.state, "pass");
	const bad = structuredClone(take);
	bad.native.wire[1].through = 16_000;
	assert.match(scoreTake(bad).gates.wire.message, /ACK/);
	assert.equal(scoreTake(bad).gates.wire.state, "fail");
	[take.native.wire[1], take.native.wire[2]] = [take.native.wire[2], take.native.wire[1]];
	assert.equal(scoreTake(take).gates.wire.state, "fail");
});

test("the preview gate uses actual worker endpoint and clipped frames, not the commit or self-reported stage", () => {
	const take = streamTrace();
	assert.equal(scoreTake(take).status, "pass");
	take.native.endpoints[0].ms = 1_000;
	take.events = take.events.filter(({ stage }) => stage !== "firstEndpoint");
	assert.equal(scoreTake(take).gates.preview.state, "fail");
	assert.equal(scoreTake(take).firstUsefulMs, null);
	take.native.endpoints = [];
	assert.equal(scoreTake(take).gates.preview.state, "pass");
	take.gaps.push({ stage: "firstEndpoint", code: "no-observer", detail: "No worker endpoint observer was attached." });
	assert.equal(scoreTake(take).gates.preview.state, "unverified");
});

test("the receiver gate rejects stale or duplicate writes despite the correct final", () => {
	const take = streamTrace();
	take.mutations.unshift({ ms: 8_700, text: `${take.trial.prefix}unrelated draft` });
	assert.equal(scoreTake(take).gates.target.state, "fail");
	take.mutations.shift();
	take.mutations.push({ ms: 9_800, text: take.expectedTarget });
	assert.equal(scoreTake(take).gates.target.state, "fail");
});

test("batch reports transport as inapplicable but still requires integrity and native observations", () => {
	const take = cpms(plan());
	assert.equal(scoreTake(take).gates.wire.state, "not-applicable");
	assert.equal(scoreTake(take).gates.pcm.state, "pass");
	take.native.asrLoads = null;
	assert.equal(scoreTake(take).status, "unverified");
	take.native.inputSamples--;
	assert.equal(scoreTake(take).gates.pcm.state, "fail");
});

test("fixture reader checks exact PCM and rejects incomplete WAV", async (t) => {
	const dir = await workspace(t);
	const pcm = Buffer.from([0, 0, 1, 0]);
	const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
	assert.throws(() => pcmFromWav(wav.subarray(0, -1)), /complete/);
	await writeFile(join(dir, "short.wav"), wav);
	await assert.rejects(readFixture(dir, plan()), /does not match/);
	assert.deepEqual((await readFixture(dir, plan(build(), 0, { pcmSha256: sha256(pcm) }))).pcm, pcm);
});

test("runner freezes calibration and writes one ordered row per failure, timeout and completed slot", async (t) => {
	const dir = await workspace(t);
	const ref = build("micme-70ad138");
	const candidate = build();
	const frozen = protocol([ref, candidate], [plan(ref), plan(candidate), plan(ref, 1), plan(candidate, 1)]);
	const manifest = join(dir, "plan.json");
	const output = join(dir, "takes.jsonl");
	await writeJson(dir, "plan.json", frozen);
	const collectors = {
		"micme-70ad138": (trial, signal) => trial.repeatIndex === 0 ? Promise.reject(new Error("private diagnostics")) :
			new Promise((done) => signal.addEventListener("abort", () => done(null), { once: true })),
		"micme-current": (trial, _signal, { clock }) => {
			assert.deepEqual(JSON.parse(readFileSync(`${output}.manifest.json`, "utf8")), frozen);
			assert.deepEqual(clock.trigger(), { stage: "trigger", ms: 0 });
			return cpms(trial);
		},
	};
	assert.deepEqual(await runTransfer(manifest, output, { collectors, timeoutMs: 50 }), { completed: 2, failed: 1, timeout: 1, lost: 0, unavailable: 0 });
	const rows = await readJsonl(output, validateTake);
	assert.deepEqual(rows.map(({ trial }) => trial), interleaveTrials(frozen));
	assert.equal(rows.some((take) => JSON.stringify(take).includes("private diagnostics")), false);
	await assert.rejects(runTransfer(manifest, output, { collectors }), { code: "EEXIST" });
});

test("aborting an attempted slot prevents later collectors without dropping planned records", async (t) => {
	const root = await workspace(t);
	const candidate = build();
	const frozen = protocol([candidate], [plan(candidate), plan(candidate, 1)]);
	const signal = new AbortController();
	const collect = t.mock.fn((slot) => { signal.abort(); return cpms(slot); });
	const output = join(root, "aborted.jsonl");
	await writeJson(root, "plan.json", frozen);
	assert.deepEqual(await runTransfer(join(root, "plan.json"), output, { collectors: { "micme-current": collect }, signal: signal.signal }),
		{ completed: 0, failed: 0, timeout: 0, lost: 1, unavailable: 1 });
	assert.equal(collect.mock.callCount(), 1);
	const rows = await readJsonl(output, validateTake);
	assert.deepEqual(rows.map(({ outcome, gaps }) => [outcome, gaps[0].code]), [["lost", "canceled"], ["unavailable", "canceled"]]);
});

test("forged tolerance is rejected before collector activation or recording", async (t) => {
	const { root, frozen } = await bundle(t);
	frozen.toleranceMs[0].ms = 1;
	await writeJson(root, "bad.json", frozen);
	const collect = t.mock.fn();
	await assert.rejects(runTransfer(join(root, "bad.json"), join(root, "none.jsonl"), { collectors: { "micme-current": collect } }), /reference\/reference calibration/);
	assert.equal(collect.mock.callCount(), 0);
});

test("a duplicated reference take cannot supply independent frozen calibration for parity", async (t) => {
	const { root, file, frozen, a, b } = await bundle(t);
	const manifest = "transfer-p1-manifest.json";
	frozen.calibration = a.slice(0, 2).map((trial) => cpms({ ...trial, pairId: "reference-calibration" }));
	frozen.toleranceMs[0].ms = 0;
	await writeJson(root, manifest, frozen);
	await writeRows(root, file, [...a, ...b].map((trial) => cpms(trial)));
	assert.match((await generateReport(root, { baselineOnly: true })).markdown, /\*\*pass\*\*.*20\/20 paired slots/);

	const [first] = frozen.calibration;
	frozen.calibration = [first, structuredClone(first)];
	await writeJson(root, manifest, frozen);
	const result = await generateReport(root, { baselineOnly: true }).then(
		({ markdown }) => markdown.split("\n").find((line) => /20\/20 paired slots/.test(line)) ?? "missing comparison",
		(error) => { assert.match(error.message, /calibration/i); return "invalid calibration"; },
	);
	assert.match(result, /invalid calibration|\*\*(?:fail|unavailable)\*\*/, "one reference observation was counted as two independent repeats");
});

test("report distinguishes 20 paired repeats, exploratory counts, and incomplete latency", async (t) => {
	const { root, file, frozen, a, b } = await bundle(t);
	const first = (await generateReport(root, { baselineOnly: true })).markdown;
	assert.equal((await generateReport(root, { baselineOnly: true })).markdown, first);
	assert.match(first, /\*\*pass\*\*.*20\/20 paired slots/);
	assert.match(first, /trigger → rawFinal \| 100 \/ 100 \(20\/20\) \| 101 \/ 101 \(20\/20\) \| 1 \/ 1 \(20\/20\) \| 2/);
	const missingRig = { ...rig, actualBackend: "unknown", actualDevice: null };
	frozen.trials = frozen.trials.map((trial) => ({ ...trial, rig: missingRig }));
	await writeJson(root, "transfer-p1-manifest.json", frozen);
	await writeRows(root, file, [...a.map((slot) => cpms(slot)), ...b.map((slot, i) => i < 18 ? cpms(slot, 101) :
		emptyTake({ ...slot, rig: missingRig }, "timeout", "no-result", "Trial expired before result."))]);
	const failed = (await generateReport(root, { baselineOnly: true })).markdown;
	assert.match(failed, /\*\*fail\*\*.*18\/20 paired slots/);
	assert.match(failed, /101 \/ ∞ \(18\/20\)/);
	const small = await bundle(t, 19);
	assert.match((await generateReport(small.root, { baselineOnly: true })).markdown, /\*\*exploratory\*\*.*19\/19 paired slots/);
	assert.deepEqual(summarize([1, 3, null]), { count: 3, finite: 2, median: 3, p95: Infinity });
});

test("P1 compares the planned matched Pi arms without using Handy's calibration", async (t) => {
	const root = await workspace(t);
	const handy = build("handy-0102");
	const historical = build("micme-70ad138");
	const current = build();
	const exact = { pairId: "pi-exact-export" };
	const defaults = { panel: "default", pairId: "product-config" };
	const left = Array.from({ length: 20 }, (_, i) => plan(historical, i, exact));
	const right = Array.from({ length: 20 }, (_, i) => plan(current, i, exact));
	const config = [plan(handy, 0, defaults), plan(current, 0, defaults)];
	const unrelated = plan(handy, 0, { pairId: "other-matched-control" });
	const frozen = protocol([handy, historical, current], [...config, unrelated, ...right, ...left]);
	frozen.calibration = [cpms(plan(handy, 0, exact), 100), cpms(plan(handy, 1, exact), 102)];
	frozen.toleranceMs = [{ from: "trigger", to: "rawFinal", ms: 2 }];
	const file = "transfer-q-p1-takes.jsonl";
	await writeJson(root, "transfer-p1-manifest.json", frozen);
	await writeRows(root, file, [cpms(config[0], 80), cpms(unrelated, 90), ...left.map((slot) => cpms(slot)),
		cpms(config[1], 85), ...right.map((slot) => cpms(slot, 101))]);
	await writeRows(root, SCORECARD_INPUTS[0], [qrow(1, handy, takeRefs(file, 2)), qrow(1, historical, takeRefs(file, 20, 3)),
		qrow(1, current, takeRefs(file, 21, 23))]);

	const { markdown } = await generateReport(root, { baselineOnly: true });
	assert.match(markdown, /\*\*handy-0102[^\n]*→ micme-current[^\n]*\n\n- \*\*exploratory\*\* — pcm · default[^\n]*1\/1 paired slots/);
	assert.match(markdown, /\*\*micme-70ad138[^\n]*→ micme-current[^\n]*\n\n- \*\*unavailable\*\* — pcm · matched[^\n]*20\/20 paired slots/);
	assert.match(markdown, /trigger → rawFinal \| 100 \/ 100 \(20\/20\) \| 101 \/ 101 \(20\/20\) \| 1 \/ 1 \(20\/20\) \| unavailable/);
});

test("a final report requires each producer and rejects public links escaping the bundle", async (t) => {
	const { root, frozen } = await bundle(t, 2);
	await assert.rejects(generateReport(root), /transfer-q-p2\.jsonl/);
	const owners = [2, 3, 4, 5, 6, 7, 7, 8, 8];
	for (let i = 0; i < owners.length; i++) await writeRows(root, SCORECARD_INPUTS[i + 1], [qrow(owners[i], frozen.products[0])]);
	await writeFile(join(root, "direct.md"), "Public direct observation\n");
	const direct = { ...qrow(8, frozen.products[0]), check: "pass", reason: null, evidence: ["direct.md"] };
	await writeRows(root, SCORECARD_INPUTS.at(-1), [
		{ ...direct, label: "adapted-verified" }, { ...direct, label: "desktop-only-verified" },
		{ ...qrow(8, frozen.products[0]), check: "unverified", label: "unverified" },
	]);
	const full = (await generateReport(root)).markdown;
	assert.match(full, /P8 C1/);
	await assert.rejects(writeTransferReport(root, join(root, "transfer-baseline.md")), /destination that matches/);
	await writeTransferReport(root, join(root, "transfer-results.md"));
	assert.equal(readFileSync(join(root, "transfer-results.md"), "utf8"), full);
	for (const label of ["existing-verified", "adapted-verified", "desktop-only-verified", "blocked", "unverified"]) assert.ok(full.includes(`| ${label} |`));
	const outside = await workspace(t);
	await writeFile(join(outside, "not-public.md"), "Out of bundle\n");
	await symlink(join(outside, "not-public.md"), join(root, "proof.md"));
	const row = qrow(2, frozen.products[0]);
	row.evidence = ["proof.md"];
	await writeRows(root, SCORECARD_INPUTS[1], [row]);
	await assert.rejects(generateReport(root), /public relative path/);
	assert.throws(() => validateScorecardRow({ ...row, evidence: ["transfer-local.json"] }), /local sidecar/);
	assert.throws(() => validateProtocol({ ...frozen, trials: [frozen.trials[0], frozen.trials[0]] }), /one slot/);
});
