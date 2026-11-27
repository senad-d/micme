import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256, wavHeader } from "./live-native/corpus.mjs";
import { collect, handyCommit, handyTag, projectHandyTake } from "./live-native/transfer-handy.mjs";
import { runTransfer } from "./live-native/transfer-runner.mjs";
import { readJsonl, validateTake } from "./live-native/transfer-schema.mjs";

const pcm = Buffer.alloc(3200, 1);
const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // Not an executable, never launched.
const weight = Buffer.from("fixture bytes, not an installed model");
const rig = { os: null, arch: null, display: null, cpu: null, gpu: null, driver: null, actualBackend: "unknown", actualDevice: null,
	requestedDevice: "cpu", threads: null, mic: null, hostVersion: null };
const build = { product: "handy-0102", tag: handyTag, commit: handyCommit, binarySha256: sha256(elfHeader), engineRevision: null,
	backend: null, modelRevision: null, modelFile: "ggml-small.bin", modelSha256: sha256(weight), quant: null, vad: null, chunkPolicy: null };
const trial = { version: 1, pairId: "handy-check", repeatIndex: 0, product: build.product, track: "pcm", panel: "matched", fixture: "short",
	pcmSha256: sha256(pcm), referenceText: "thank you", language: "en", task: "transcribe", rig, build, width: null, target: "none", prefix: null,
	cache: "cold-process", disk: "unknown", load: "idle", processing: "off", input: "file", gesture: "none" };
const desktop = { ...trial, track: "destination", input: "loopback", gesture: "toggle", width: 40, target: "external-editor", prefix: "Prefix · " };
const signal = () => new AbortController().signal;

async function workspace(t) {
	const dir = await mkdtemp(join(tmpdir(), "transfer-handy-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function inputs(t) {
	const dir = await workspace(t);
	const weights = join(dir, "explicit-weight.bin"), handyBinary = join(dir, "pkg", "bin", "handy");
	const sentinel = join(dir, "unrelated-history.db");
	await mkdir(join(dir, "pkg", "bin"), { recursive: true });
	await Promise.all([
		writeFile(weights, weight), writeFile(handyBinary, elfHeader), writeFile(sentinel, "unrelated profile"),
		writeFile(join(dir, "short.wav"), Buffer.concat([wavHeader(pcm.length), pcm])),
	]);
	return { sentinel, local: { assetsDir: dir, workDir: dir, handyBinary, handyModelFiles: [{ catalogId: "small", file: weights, sha256: sha256(weight) }] } };
}

function checkGap(take, code) {
	assert.equal(validateTake(take).outcome, "unavailable");
	assert.deepEqual(take.events, []);
	assert.deepEqual(take.mutations, []);
	assert.equal(take.raw, null);
	assert.equal(take.gaps[0].code, code);
}

const nonRootLinux = process.platform === "linux" && process.getuid() !== 0;

test("rejects a pinned model whose local bytes differ and keeps unrelated history and inputs", { skip: !nonRootLinux }, async (t) => {
	const { local, sentinel } = await inputs(t);
	await writeFile(local.handyModelFiles[0].file, "still the same path, but changed bytes");
	const before = (await readdir(local.workDir)).sort();
	const take = await collect(desktop, signal(), { local });
	checkGap(take, "identity-mismatch");
	assert.match(take.gaps[0].detail, /weight SHA-256/);
	assert.deepEqual((await readdir(local.workDir)).sort(), before);
	assert.equal(await readFile(sentinel, "utf8"), "unrelated profile");
});

test("reports denied provision access separately from a digest mismatch", { skip: !nonRootLinux }, async (t) => {
	const { local } = await inputs(t);
	await chmod(local.handyBinary, 0);
	checkGap(await collect(trial, signal(), { local }), "missing-permission");
});

test("rejects an incomplete provision and distinguishes an unsupported gesture from an unowned target", async (t) => {
	checkGap(await collect(desktop, signal(), { local: null }), "missing-input");
	const { local } = await inputs(t);
	checkGap(await collect({ ...desktop, gesture: "hold-release" }, signal(), { local }), "unsupported");
	checkGap(await collect({ ...desktop, target: "pi-prompt" }, signal(), { local }), "no-observer");
});

test("the real comparison runner writes an attempted Handy slot without activating a missing Linux package", { skip: !nonRootLinux }, async (t) => {
	const { local, sentinel } = await inputs(t);
	const dir = local.workDir;
	const manifest = join(dir, "manifest.json"), output = join(dir, "output.jsonl");
	await writeFile(manifest, JSON.stringify({ version: 1, products: [build], trials: [trial], calibration: [], toleranceMs: [],
		minimumTimed: 20, createdUtc: "2026-11-27T00:00:00Z" }));
	await writeFile(join(dir, "transfer-local.json"), JSON.stringify({ ...local, piBinary: null, tagCheckout: null, historicalCheckout: null,
		currentCheckout: null, backendFiles: [], whisperModelFiles: [], vadFile: null }));
	const totals = await runTransfer(manifest, output);
	assert.deepEqual(totals, { completed: 0, failed: 0, timeout: 0, lost: 0, unavailable: 1 });
	const rows = await readJsonl(output, validateTake);
	assert.equal(rows.length, 1);
	checkGap(rows[0], "missing-host");
	assert.match(rows[0].gaps[0].detail, /lib\/Handy package/);
	assert.equal(await readFile(sentinel, "utf8"), "unrelated profile");
});

const event = (stage, ns) => ({ kind: "event", stage, ns: String(ns) });
const binding = { kind: "binding", backend: "CPU", device: "fixture bound CPU", streaming: false };
const stamps = [event("modelLoaded", 3_000_000), event("trigger", 4_000_000), event("rawFinal", 9_000_000)];

test("verified WAV CLI data never claims capture, visible drafts, or receiver timings", () => {
	const take = validateTake(projectHandyTake(trial, [...stamps, binding, { kind: "result", outcome: "completed", text: "thank you", computeMs: 2, consumed: true }], pcm.length, {}));
	assert.deepEqual(take.events, [{ stage: "modelLoaded", ms: -1 }, { stage: "trigger", ms: 0 }, { stage: "rawFinal", ms: 5 }]);
	assert.equal(take.fedSha256, trial.pcmSha256);
	assert.equal(take.cleaned, "thank you");
	assert.equal(take.computeMs, 2);
	assert.equal(take.native, null);
	assert.equal(take.observedTarget, null);
	assert.equal(take.trial.rig.actualDevice.label, binding.device);
	assert.deepEqual(take.gaps.map(({ stage, code }) => [stage, code]), [["firstUseful", "unsupported"], ["firstEndpoint", "unsupported"], ["rawFinal", "no-observer"]]);
});

test("the receiver trace, not the app's final or claimed paste, supplies target time and duplicate evidence", () => {
	const expectedTarget = `${desktop.prefix}thank you`;
	const trace = [...stamps, binding, { kind: "receiver" }, { kind: "idleAudio" }, { kind: "route" },
		{ kind: "mutation", ns: "12000000", text: expectedTarget }, { kind: "mutation", ns: "14000000", text: `${expectedTarget}thank you` },
		{ kind: "result", outcome: "completed", text: "thank you", observedTarget: `${expectedTarget}thank you` }];
	const take = validateTake(projectHandyTake(desktop, trace, pcm.length, {}));
	assert.equal(take.expectedTarget, expectedTarget);
	assert.equal(take.observedTarget, `${expectedTarget}thank you`);
	assert.deepEqual(take.events.at(-1), { stage: "correctTarget", ms: 8 });
	assert.equal(take.duplicateInsertions, 1);
	assert.equal(take.fedBytes, null);
	assert.equal(take.idleMicOpen, false);
	const failure = validateTake(projectHandyTake(desktop, [...stamps, { kind: "receiver" },
		{ kind: "result", outcome: "failed", code: "no-result", detail: "paste did not arrive", text: "thank you", observedTarget: desktop.prefix }], pcm.length, {}));
	assert.equal(failure.outcome, "failed");
	assert.equal(failure.observedTarget, desktop.prefix);
	assert.ok(!failure.events.some(({ stage }) => stage === "correctTarget"));
});
