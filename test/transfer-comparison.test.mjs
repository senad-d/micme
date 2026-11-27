import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { wavHeader } from "./live-native/corpus.mjs";
import { runTransfer } from "./live-native/transfer-runner.mjs";
import { readJsonl, validateTake } from "./live-native/transfer-schema.mjs";

const quality = fileURLToPath(new URL("./live-native-quality.mjs", import.meta.url));
const exec = promisify(execFile);
const digest = (data) => createHash("sha256").update(data).digest("hex");
const phrase = "but now it matters very much in eighteen sixty three";
const prefix = "Public prompt: ";
const silencePcm = Buffer.alloc(10 * 16_000 * 2);
// Non-silence stand-in PCM; the only real WAV use here is testing refusal before activation.
const pcm = Buffer.from(silencePcm);
pcm.writeInt16LE(1, 16_000);
const rig = { os: "linux", arch: "x64", display: "private display", cpu: "fixture CPU", gpu: null, driver: null,
	actualBackend: "cpu", actualDevice: { id: "fixture-cpu", label: "Fixture CPU" }, requestedDevice: "cpu", threads: 2, mic: null, hostVersion: "fixture host" };

function build(product, changes = {}) {
	const handy = product === "handy-0102";
	return { product, tag: handy ? "v0.10.2" : null, commit: handy ? "a822741f9c697b6f6a00c557e4817bf59ae70867" : digest(product).slice(0, 40),
		binarySha256: digest(product), engineRevision: "fixture engine revision", backend: "worker", modelRevision: "fixture model revision",
		modelFile: "fixture-weights.bin", modelSha256: digest("inert fixture weights"), quant: "f16", vad: "off", chunkPolicy: "off", ...changes };
}

function slot(artifact, pairId, repeatIndex = 0, changes = {}) {
	return { version: 1, pairId, repeatIndex, product: artifact.product, build: artifact, track: "destination", panel: "matched",
		fixture: "continuous", pcmSha256: digest(pcm), referenceText: phrase, language: "en", task: "transcribe", rig,
		width: 40, target: "pi-prompt", prefix, cache: "cold-process", disk: "cached", load: "idle", processing: "off",
		input: "loopback", gesture: "toggle", ...changes };
}

function protocol(trials, calibration = [], toleranceMs = []) {
	return { version: 1, products: [...new Set(trials.map(({ build }) => build))], trials, calibration, toleranceMs,
		minimumTimed: 20, createdUtc: "2026-11-26T00:00:00Z" };
}

async function workspace(t) {
	const root = await mkdtemp(join(tmpdir(), "cmp-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

const json = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`);
const jsonl = (path, records) => writeFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
const command = (root, ...args) => exec(process.execPath, [quality, ...args], { cwd: root });

function times(overrides) {
	return Object.entries(overrides).map(([stage, ms]) => ({ stage, ms }));
}

function noResult(trial, outcome, code, detail) {
	return { trial, outcome, native: null, gaps: [{ stage: null, code, detail }], events: [], visible: [], commits: [], mutations: [],
		expectedTarget: null, observedTarget: null, raw: null, cleaned: null, replayed: null, delivered: null, sentCount: null,
		queuedCount: null, pcmBytes: null, fedBytes: null, fedSha256: null, computeMs: null, audioMs: null, peakLagSamples: null,
		peakRssBytes: null, idleRssBytes: null, idleMicOpen: null, missedOnset: null, missedTail: null, repeatErrors: null,
		staleInsertions: null, duplicateInsertions: null };
}

// Synthetic B observations for the reporter, not a capture or an ASR measurement.
function publicTake(trial) {
	const silence = trial.fixture === "silence";
	const count = pcm.length / 2;
	const target = trial.prefix + trial.referenceText;
	const speech = times({ modelLoaded: -50, trigger: 0, firstSample: 25, readyCue: 55, speechOnset: 100, firstUseful: 1_300,
		speechEnd: 8_500, stopGesture: 8_700, firstCommit: 9_100, drained: 9_300, rawFinal: 9_500, correctTarget: 9_700 });
	const drafts = ["but now", "but now it matters", "but now it matters very much", "…it matters very much in eighteen", "…very much in eighteen sixty three"];
	return { ...noResult(trial, "completed", "no-result", "Not used"), gaps: [],
		events: silence ? times({ modelLoaded: -50, trigger: 0, rawFinal: 9_500 }) : speech,
		visible: silence ? [] : drafts.map((text, i) => ({ ms: [1_300, 2_900, 4_500, 6_200, 8_300][i], text: `Live: ${text}` })),
		commits: silence ? [] : [{ ms: 9_100, text: phrase }], mutations: silence ? [] : [{ ms: 9_700, text: target }],
		expectedTarget: silence ? null : target, observedTarget: silence ? null : target, raw: trial.referenceText,
		delivered: silence ? null : phrase, sentCount: 0, queuedCount: 0, pcmBytes: pcm.length, fedBytes: pcm.length, fedSha256: trial.pcmSha256,
		computeMs: 400, audioMs: 10_000, peakLagSamples: 0, peakRssBytes: 100, idleRssBytes: 50,
		idleMicOpen: false, missedOnset: false, missedTail: false, repeatErrors: 0, staleInsertions: 0, duplicateInsertions: 0,
		native: { route: silence ? "batch" : "stream", asrCalls: silence ? 0 : 1, asrLoads: 1, vadLoads: 0,
			capturedSamples: count, closedSamples: count, inputSamples: count, inputPcmSha256: trial.pcmSha256,
			wire: silence ? null : [{ kind: "feed", from: 0, through: 80_000, catchUp: false }, { kind: "ack", through: 80_000 },
				{ kind: "feed", from: 80_000, through: count, catchUp: false }, { kind: "ack", through: count }, { kind: "finish" }, { kind: "done", through: count }],
			endpoints: silence ? [] : [{ ms: 9_000, text: phrase }], chunks: null, matchedClipRaw: trial.referenceText,
			alignedWords: silence ? [] : phrase.split(" ").map((word, i) => ({ word, endMs: 400 + 800 * i })),
			onsetMs: 100, endMs: 8_500, workerCleanExit: true } };
}

async function privateFixture(root) {
	const profile = join(root, "unowned-profile");
	const workDir = join(root, "work");
	const assetsDir = join(root, "assets");
	const bin = join(root, "bin");
	const binary = join(bin, "product");
	const weights = join(assetsDir, "fixture-weights.bin");
	const socket = join(root, "outside.sock");
	const invocation = join(root, "invoked");
	const activation = join(root, "activation");
	const shellPath = (path) => `'${path.replaceAll("'", "'\\''")}'`;
	const script = `#!/bin/sh
printf '%s\\n' invoked >> ${shellPath(invocation)}
case "$1" in
  --version|-V|--help|--protocol-version) exit 0 ;;
esac
printf '%s\\n' activated >> ${shellPath(activation)}
`;
	const state = { "history.db": "history canary", "model-cache": "cache canary", clipboard: "clipboard canary" };
	await Promise.all([profile, workDir, assetsDir, bin].map((path) => mkdir(path)));
	await Promise.all(Object.entries(state).map(([key, value]) => writeFile(join(profile, key), value)));
	await writeFile(binary, script, { mode: 0o700 });
	await writeFile(weights, "inert fixture weights");
	await writeFile(join(assetsDir, "continuous.wav"), Buffer.concat([wavHeader(pcm.length), pcm]));
	return { profile, workDir, assetsDir, bin, binary, binarySha256: digest(script), weights, socket, invocation, activation, state };
}

function provisioning(fixture, artifact, workDir) {
	const { assetsDir, binary, binarySha256, weights } = fixture;
	return { assetsDir, workDir, handyBinary: binary, piBinary: binary, tagCheckout: null, historicalCheckout: null, currentCheckout: null,
		backendFiles: [{ product: "micme-current", workerFile: binary, clipFile: binary, streamFile: binary,
			workerSha256: binarySha256, clipSha256: binarySha256, streamSha256: binarySha256 }],
		handyModelFiles: [{ catalogId: artifact.modelFile, file: weights, sha256: artifact.modelSha256 }],
		whisperModelFiles: [{ name: artifact.modelFile, file: weights, sha256: artifact.modelSha256 }], vadFile: null };
}

async function canary(t, socket) {
	const connections = [];
	const server = createServer((peer) => { connections.push("connected"); peer.destroy(); });
	server.listen(socket);
	await once(server, "listening");
	t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	return connections;
}

test("public collectors refuse unproven identity, instance, target and loopback without activating or touching external state", async (t) => {
	const root = await workspace(t);
	const fixture = await privateFixture(root);
	const connections = await canary(t, fixture.socket);
	const env = { PATH: fixture.bin, HOME: fixture.profile, XDG_CONFIG_HOME: fixture.profile, XDG_DATA_HOME: fixture.profile,
		XDG_CACHE_HOME: fixture.profile, XDG_RUNTIME_DIR: fixture.profile, TMPDIR: fixture.workDir, DISPLAY: "",
		PULSE_SERVER: `unix:${fixture.socket}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${fixture.socket}`, PI_CODING_AGENT_DIR: fixture.profile };
	const unobservedRig = { ...rig, os: null, arch: null, display: null, cpu: null, actualBackend: "unknown", actualDevice: null,
		threads: null, hostVersion: null };
	const cases = [
		["wrong binary digest", { binarySha256: digest("different binary") },
			{ track: "pcm", input: "file", target: "none", prefix: null, width: null, gesture: "none" }, fixture.workDir],
		["unowned writable state", {}, {}, join(fixture.profile, "history.db")],
		["missing destination", {}, { target: "none", prefix: null }, fixture.workDir],
		["missing private loopback", {}, {}, fixture.workDir],
	];
	const refusals = ["identity-mismatch", "unsafe-instance", "missing-input", "missing-host", "missing-permission", "no-observer"];
	for (const product of ["handy-0102", "micme-current"]) {
		for (const [name, buildOverrides, settings, workDir] of cases) {
			await t.test(`${product}: ${name}`, async () => {
				const artifact = build(product, { binarySha256: fixture.binarySha256, ...buildOverrides });
				const trial = slot(artifact, name, 0, { rig: unobservedRig, target: product === "handy-0102" ? "external-editor" : "pi-prompt", ...settings });
				const manifest = join(root, "plan.json");
				const output = join(root, `${product}-${name}.jsonl`);
				await json(manifest, protocol([trial]));
				await json(join(root, "transfer-local.json"), provisioning(fixture, artifact, workDir));
				await exec(process.execPath, [quality, "--transfer", manifest, output], { cwd: root, env, timeout: 10_000 });
				assert.deepEqual((await readdir(fixture.profile)).sort(), Object.keys(fixture.state).sort());
				for (const [file, value] of Object.entries(fixture.state)) assert.equal(await readFile(join(fixture.profile, file), "utf8"), value);
				assert.deepEqual(connections, [], "the unrelated audio/session endpoint must not be contacted");
				await assert.rejects(readFile(fixture.activation), { code: "ENOENT" });
				if (name === "wrong binary digest") await assert.rejects(readFile(fixture.invocation), { code: "ENOENT" });
				const rows = await readJsonl(output, validateTake);
				assert.equal(rows.length, 1);
				const [take] = rows;
				assert.equal(take.trial.product, product);
				assert.ok(["failed", "unavailable"].includes(take.outcome));
				assert.ok(take.gaps.some(({ code, detail }) => refusals.includes(code) && !/install the corresponding isolated product collector|collector could not load/i.test(detail)),
					`expected an isolation or provisioning refusal from the collector: ${JSON.stringify(take.gaps)}`);
				assert.ok(!take.events.some(({ stage }) => stage === "trigger" || stage === "firstSample" || stage === "correctTarget"));
				assert.deepEqual(take.mutations, []);
				assert.equal(take.observedTarget, null);
			});
		}
	}
});

test("runner keeps a timed-out attempt and a distinct readback from an isolated public receiver", async (t) => {
	const root = await workspace(t);
	const manifest = join(root, "plan.json");
	const output = join(root, "attempts.jsonl");
	const target = join(root, "public-receiver.txt");
	const artifact = build("micme-current", { backend: "scripted" });
	const trials = [slot(artifact, "receiver"), slot(artifact, "receiver", 1)];
	await json(manifest, protocol(trials));
	await writeFile(target, prefix);
	const invoked = [];
	const aborted = [];
	const collect = (trial, signal, { clock }) => {
		invoked.push(trial.repeatIndex);
		const trigger = clock.trigger();
		if (trial.repeatIndex === 0) {
			return new Promise((resolve) => signal.addEventListener("abort", () => {
				aborted.push(trial.repeatIndex);
				// Even a successful-looking result arriving on abort is not evidence of delivery.
				resolve(publicTake(trial));
			}, { once: true }));
		}
		const expectedTarget = prefix + phrase;
		writeFileSync(target, expectedTarget);
		const observedTarget = readFileSync(target, "utf8");
		const ms = clock.ms();
		return { ...noResult(trial, "completed", "unsupported", "File receiver fixture has no native observer."),
			events: [trigger, { stage: "correctTarget", ms }], expectedTarget, observedTarget, mutations: [{ ms, text: observedTarget }] };
	};
	const totals = await runTransfer(manifest, output, { timeoutMs: 50, collectors: { "micme-current": collect } });
	assert.deepEqual(totals, { completed: 1, failed: 0, timeout: 1, lost: 0, unavailable: 0 });
	assert.deepEqual(aborted, [0]);
	const rows = await readJsonl(output, validateTake);
	assert.deepEqual(rows.map(({ trial }) => trial.repeatIndex), invoked);
	const [timeout, completed] = rows.toSorted((a, b) => a.trial.repeatIndex - b.trial.repeatIndex);
	assert.equal(timeout.outcome, "timeout");
	assert.equal(timeout.raw, null);
	assert.deepEqual(timeout.mutations, []);
	assert.equal(completed.observedTarget, prefix + phrase);
	const delivery = completed.events.find(({ stage }) => stage === "correctTarget");
	assert.ok(delivery.ms >= 0);
	assert.deepEqual(completed.mutations, [{ text: prefix + phrase, ms: delivery.ms }]);
	assert.equal(await readFile(target, "utf8"), prefix + phrase);
});

const p1 = "transfer-q-p1.jsonl";
const traces = "transfer-q-p1-takes.jsonl";
const laterInputs = ["p2", "p3", "p4", "p5", "p6", "p7-import", "p7-cli", "p8-provider", "p8-final"];

function qrow(phase, artifact, takes) {
	return { version: 1, phase, feature: phase === 1 ? "BASE" : "C1", build: artifact, rig: null, language: null,
		task: null, target: null, cache: null, fixture: null, provider: null, check: takes.length ? "pass" : "blocked",
		label: takes.length ? "existing-verified" : "blocked", reason: takes.length ? null : "Need a provisioned host and actual receiver evidence.",
		evidence: [], takes, before: [] };
}

async function saveArchive(root, manifest, records) {
	await json(join(root, "transfer-p1-manifest.json"), manifest);
	await jsonl(join(root, traces), records);
	await jsonl(join(root, p1), manifest.products.map((artifact) => qrow(1, artifact, records.flatMap(({ trial }, i) =>
		trial.build.product === artifact.product ? [{ file: traces, line: i + 1 }] : []))));
}

function slotLine(markdown, id, repeat = 0, product = null) {
	const line = markdown.split("\n").find((line) => line.startsWith(`| ${id} #${repeat} [`) && (!product || line.includes(`| ${product} / `)));
	assert.ok(line, `missing evidence row for ${id} #${repeat}${product ? ` (${product})` : ""}`);
	return line;
}

test("report regrades one changed B observation at a time and keeps native, display and receiver clocks distinct", async (t) => {
	const root = await workspace(t);
	const artifact = build("micme-current", { backend: "scripted" });
	const stream = publicTake(slot(artifact, "stream-control"));
	const silent = publicTake(slot(artifact, "silence-control", 0, { fixture: "silence", referenceText: "", pcmSha256: digest(silencePcm),
		track: "pcm", width: null, target: "none", prefix: null, input: "file", gesture: "none" }));
	const cases = [
		["asr-on-silence", silent, (bad) => { bad.native.asrCalls = 1; }, /silenceCalls: fail/],
		["pending-ack", stream, (bad) => { [bad.native.wire[1], bad.native.wire[2]] = [bad.native.wire[2], bad.native.wire[1]]; }, /wire: fail/],
		["endpoint-before-preview", stream, (bad) => { bad.native.endpoints[0].ms = 1_200; }, /preview: fail/],
		["stale-receiver", stream, (bad) => { bad.mutations.unshift({ ms: 9_600, text: `${prefix}old take` }); }, /target: fail/],
		["duplicate-receiver", stream, (bad) => { bad.mutations.push({ ms: 9_800, text: bad.observedTarget }); }, /target: fail/],
		["missing-receiver", stream, (bad) => {
			bad.mutations = [];
			bad.gaps.push({ stage: "correctTarget", code: "no-observer", detail: "The receiver mutation could not be observed." });
		}, /target: unverified/],
	];
	const records = [stream, silent];
	for (const [id, control, change] of cases) {
		const variant = structuredClone(control);
		variant.trial = { ...control.trial, pairId: id };
		change(variant);
		records.push(variant);
	}
	const output = join(root, "transfer-baseline.md");
	await saveArchive(root, protocol(records.map(({ trial }) => trial)), records);
	await command(root, "--transfer-report", root, output, "--baseline-only");
	const markdown = await readFile(output, "utf8");
	assert.match(slotLine(markdown, "stream-control"), /completed \| pass\b/);
	assert.match(slotLine(markdown, "silence-control"), /completed \| pass\b/);
	assert.ok(slotLine(markdown, "stream-control").includes(`${prefix}${phrase} / ${prefix}${phrase}`));
	for (const [id, , , verdict] of cases) assert.match(slotLine(markdown, id), verdict);
	assert.match(markdown, /speechOnset → firstUseful \| 1200 \/ ∞ \(5\/6\)/);
	assert.match(markdown, /speechOnset → firstEndpoint \| 8900 \/ 8900 \(6\/6\)/);
	assert.match(markdown, /speechOnset → firstCommit \| 9000 \/ 9000 \(6\/6\)/);
	assert.match(markdown, /stopGesture → correctTarget \| 1000 \/ ∞ \(5\/6\)/);
});

test("report regeneration counts short, unmatched, failed and scripted cohorts without claiming parity", async (t) => {
	const root = await workspace(t);
	const left = build("micme-70ad138");
	const right = build("micme-current", { backend: "scripted" });
	const archived = build("micme-041");
	const cohorts = [
		{ id: "short", count: 19, a: left, b: archived },
		{ id: "scripted", count: 20, a: left, b: right, changes: { disk: "unknown" } },
		{ id: "unmatched", count: 1, a: left, b: archived, changes: { width: 80 }, alter: (take) => {
			take.trial = { ...take.trial, rig: { ...rig, actualDevice: { id: "different-cpu", label: null } } };
		} },
		{ id: "timeout", count: 2, a: left, b: archived, changes: { load: "contended" }, alter: (take) => take.trial.repeatIndex > 0 ?
			noResult(take.trial, "timeout", "no-result", "Receiver never completed.") : take },
	];
	const trials = [];
	const records = [];
	for (const { id, count, a, b, changes, alter } of cohorts) {
		for (let i = 0; i < count; i++) {
			const reference = slot(a, id, i, changes);
			const candidate = slot(b, id, i, changes);
			if (id === "unmatched") candidate.rig = { ...rig, actualDevice: null };
			trials.push(reference, candidate);
			const observed = publicTake(candidate);
			records.push(publicTake(reference), alter?.(observed) ?? observed);
		}
	}
	const calibration = [0, 1].map((i) => publicTake(slot(left, "independent-calibration", i, { disk: "unknown" })));
	const manifest = protocol(trials, calibration, [{ from: "stopGesture", to: "correctTarget", ms: 0 }]);
	await saveArchive(root, manifest, records);
	const output = join(root, "transfer-baseline.md");
	await command(root, "--transfer-report", root, output, "--baseline-only");
	const baseline = await readFile(output, "utf8");
	assert.doesNotMatch(baseline, /^- \*\*pass\*\*/m);
	assert.match(baseline, /\*\*exploratory\*\*.*19\/19 paired slots/);
	assert.match(baseline, /\*\*unavailable\*\*.*20\/20 paired slots/);
	assert.match(baseline, /\*\*unavailable\*\*.*0\/1 paired slots/);
	assert.match(baseline, /\*\*fail\*\*.*2\/2 paired slots/);
	assert.match(baseline, /\| 2 \| 2 \| 0 \| 1 \/ 0 \/ 1 \/ 0 \/ 0 \|/);
	assert.match(baseline, /1000 \/ ∞ \(1\/2\)/);
	assert.match(slotLine(baseline, "timeout", 1, "micme-041"), /micme-041 \/ timeout/);
	assert.match(slotLine(baseline, "timeout", 1, "micme-70ad138"), /micme-70ad138 \/ completed/);
	const full = join(root, "transfer-results.md");
	await assert.rejects(command(root, "--transfer-report", root, full), { stderr: /transfer-q-p2\.jsonl/ });
	for (const name of laterInputs) await jsonl(join(root, `transfer-q-${name}.jsonl`), [qrow(Number(name[1]), archived, [])]);
	await command(root, "--transfer-report", root, full);
	const regenerated = await readFile(full, "utf8");
	assert.match(regenerated, /P8 C1/);
	assert.match(regenerated, /transfer-q-p7-cli\.jsonl/);
	assert.doesNotMatch(regenerated, /^- \*\*pass\*\*/m);
	await command(root, "--transfer-report", root, full);
	assert.equal(await readFile(full, "utf8"), regenerated);
	assert.equal(await readFile(output, "utf8"), baseline);
});

for (const [file, options] of [["transfer-baseline.md", ["--baseline-only"]], ["transfer-results.md", []]]) {
	test(`${file} matches regeneration from the checked-in evidence`, async (t) => {
		const root = await workspace(t);
		const bundle = fileURLToPath(new URL("./live-native/", import.meta.url));
		const output = join(root, file);
		await command(root, "--transfer-report", bundle, output, ...options);
		const [published, generated] = await Promise.all([readFile(join(bundle, file)), readFile(output)]);
		assert.equal(digest(published), digest(generated), `${file} is stale; regenerate it from the checked-in B/Q inputs`);
	});
}
