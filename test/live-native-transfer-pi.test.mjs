import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256, wavHeader } from "./live-native/corpus.mjs";
import { checkout, closePi, enterCommand, installedPi, isolatedPi, observedPi, publicPrefix, traceRows, waitFor } from "./live-native/transfer-pi-local.mjs";
import { collect, piSourceSha256 } from "./live-native/transfer-pi.mjs";
import { validateTake } from "./live-native/transfer-schema.mjs";

const first = "Public fixture";
const tail = `${"checks an isolated terminal, a rendered draft, and a confirmed editor mutation. ".repeat(12)}This is the final public sentence.`;
const text = `${first} ${tail}`;
const commit = "0123456789abcdef0123456789abcdef01234567"; // Test-only receipt, not a checkout claim.
const linux = { skip: process.platform !== "linux", timeout: 30_000 };

// The only substitutes are the two recognizers and their weights. Pi, its real
// shortcut, the paced recorder, and the production Worker v1 client stay in use.
const worker = String.raw`
const send = (type, fields) => console.log(JSON.stringify({type, ...fields}));
if (process.argv.includes('--protocol-version')) { console.log('1'); process.exit(0); }
console.error('using CPU backend');
send('ready', {version: 1, rate: 16000, loadMs: 0, asrLoads: 1, vadLoads: 1});
let through = 0, confirmed = 0, revision = 0, bytes = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  bytes = Buffer.concat([bytes, chunk]);
  while (bytes.length) {
    const op = bytes[0];
    if (op === 3) {
      if (confirmed) send('final', {from: confirmed, to: through, text: ${JSON.stringify(tail)}});
      send('done', {through, asrCalls: confirmed ? 2 : 0, asrMs: 0, vadFrames: 0});
      process.stdin.pause();
      return;
    }
    if (bytes.length < 5) return;
    const samples = bytes.readUInt32LE(1), size = 5 + samples * 2;
    if (bytes.length < size) return;
    bytes = bytes.subarray(size);
    through += samples;
    if (through >= 28800 && !confirmed) {
      confirmed = through;
      send('final', {from: 0, to: through, text: ${JSON.stringify(first)}});
    } else if (op === 1 && !confirmed && through >= (revision === 0 ? 6400 : 14400) && revision < 2) {
      send('partial', {from: 0, to: through, text: revision++ === 0 ? ${JSON.stringify(first)} : ${JSON.stringify(`${first} checks an isolated terminal`)}});
    }
    send('ack', {through});
  }
});
`;

async function workspace(t) {
	const dir = await mkdtemp(join(tmpdir(), "pi-collector-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function provision(t, backendDiagnostic = "using CPU backend") {
	const workDir = await workspace(t);
	const assetsDir = join(workDir, "wavs");
	await mkdir(assetsDir);
	const workerFile = join(workDir, "worker.cjs"), clipFile = join(workDir, "clip.cjs");
	const modelFile = join(workDir, "ggml-base.en.bin"), vadFile = join(workDir, "silero.bin");
	const fixtureModel = "Scripted public test fixture; not model weights.";
	const clip = `const {writeFileSync} = require('node:fs');\nwriteFileSync(process.argv[process.argv.indexOf('-of') + 1] + '.json', JSON.stringify({transcription: [{text: ${JSON.stringify(text)}}]}));\n`;
	await Promise.all([
		writeFile(workerFile, `#!${process.execPath}\n${worker.replace("using CPU backend", backendDiagnostic)}`, { mode: 0o700 }),
		writeFile(clipFile, `#!${process.execPath}\n${clip}`, { mode: 0o700 }),
		writeFile(modelFile, fixtureModel), writeFile(vadFile, fixtureModel),
	]);
	const product = "micme-current";
	const backend = { product, workerFile, clipFile, workerSha256: sha256(await readFile(workerFile)), clipSha256: sha256(await readFile(clipFile)) };
	const modelSha256 = sha256(fixtureModel);
	const receipt = { commit, sourceSha256: await piSourceSha256(checkout), piSha256: sha256(await readFile(installedPi)), vadSha256: modelSha256 };
	await writeFile(join(workDir, "transfer-pi-sources.json"), JSON.stringify({ [product]: receipt }));
	const local = { assetsDir, workDir, currentCheckout: checkout, piBinary: installedPi, vadFile, backendFiles: [backend],
		whisperModelFiles: [{ name: "base.en", file: modelFile, sha256: modelSha256 }] };
	const rig = { os: null, arch: null, display: "Linux PTY", cpu: null, gpu: null, driver: null, actualBackend: "unknown", actualDevice: null,
		requestedDevice: "cpu", threads: null, mic: "paced public WAV hook", hostVersion: null };
	const build = { product, commit, binarySha256: backend.workerSha256, tag: null, engineRevision: null, backend: null, modelRevision: null,
		modelFile: "ggml-base.en.bin", modelSha256, quant: null, vad: null, chunkPolicy: null };
	const trial = { version: 1, pairId: "pi-collector-scripted-test", repeatIndex: 0, product, track: "destination", panel: "matched",
		language: "en", task: "transcribe", rig, build, width: 40, target: "pi-prompt", prefix: publicPrefix, cache: "cold-process", disk: "unknown",
		load: "idle", processing: "off", input: "file", gesture: "toggle" };
	return { trial, local };
}

async function stageFixture(local, fixture, pcm) {
	await writeFile(join(local.assetsDir, `${fixture}.wav`), Buffer.concat([wavHeader(pcm.length), pcm]));
	return { fixture, pcmSha256: sha256(pcm), referenceText: fixture === "immediate" ? null : text };
}

function times(take) { return Object.fromEntries(take.events.map(({ stage, ms }) => [stage, ms])); }

function assertComplete(take) {
	assert.equal(take.outcome, "completed", JSON.stringify({ gaps: take.gaps, events: take.events, observedTarget: take.observedTarget }));
	assert.equal(take.sentCount, 0);
	assert.equal(take.queuedCount, 0);
	assert.equal(take.fedSha256, take.trial.pcmSha256);
	assert.equal(take.native.workerCleanExit, true);
}

test("Pi collector joins long scrolled targets and replay to exact readback without counting worker drafts as display", linux, async (t) => {
	const { local, trial } = await provision(t);
	const fixture = await stageFixture(local, "continuous", Buffer.alloc(128_000, 1));
	// A synthetic timeline tests alignment projection; it is not corpus data.
	const words = text.split(" ").map((word, index) => ({ word, endMs: 40 + index * 26 }));
	await writeFile(join(local.assetsDir, "transfer-fixtures.json"), JSON.stringify({ fixtures: {
		continuous: { hash: fixture.pcmSha256, onsetMs: 10, endMs: words.at(-1).endMs, words },
	} }));
	const take = validateTake(await collect({ ...trial, ...fixture }, t.signal, { local }));
	assertComplete(take);
	const stamp = times(take);
	assert.deepEqual(take.visible.filter(({ text }) => text).map(({ text }) => text), ["Live: Public fixture", "Live: …checks an isolated terminal"]);
	assert.ok(Math.abs(take.visible[0].ms - stamp.firstUseful) < 0.001);
	assert.ok(take.visible[1].ms < stamp.firstEndpoint && stamp.firstEndpoint < stamp.firstCommit);
	assert.ok(stamp.firstCommit < stamp.stopGesture && stamp.stopGesture < stamp.correctTarget);
	assert.equal(take.raw, text);
	assert.equal(take.observedTarget, `${publicPrefix} ${text} `);
	assert.equal(take.mutations.at(-1).ms, stamp.correctTarget);
	assert.equal(take.replayed, text);
});

test("Pi collector stops and drains a single zero block without contaminating the public prompt", linux, async (t) => {
	const { local, trial } = await provision(t);
	const fixture = await stageFixture(local, "immediate", Buffer.alloc(640));
	const take = validateTake(await collect({ ...trial, ...fixture }, t.signal, { local }));
	assertComplete(take);
	assert.equal(take.trial.rig.actualBackend, "cpu");
	const stamp = times(take);
	assert.ok(stamp.firstSample < stamp.readyCue && stamp.readyCue < stamp.stopGesture && stamp.stopGesture < stamp.drained);
	assert.equal(take.native.asrCalls, 0);
	assert.equal(take.native.closedSamples, 320);
	assert.deepEqual(take.native.wire.map(({ kind }) => kind), ["feed", "ack", "finish", "done"]);
	assert.equal(take.observedTarget, publicPrefix);
	assert.deepEqual(take.mutations, []);
	assert.equal(take.replayed, null);
});

test("Pi collector refuses a Vulkan request before triggering the provisioned Worker v1 route", linux, async (t) => {
	const { local, trial } = await provision(t);
	const fixture = await stageFixture(local, "immediate", Buffer.alloc(640));
	const take = validateTake(await collect({ ...trial, ...fixture, rig: { ...trial.rig, requestedDevice: "vulkan" } }, t.signal, { local }));
	assert.equal(take.outcome, "unavailable");
	assert.deepEqual(take.events, []);
	assert.equal(take.trial.rig.actualBackend, "unknown");
	assert.equal(take.gaps[0].code, "unsupported");
	assert.match(take.gaps[0].detail, /compute selection/i);
});

test("Pi collector does not certify CPU when the Worker v1 default reports a different backend", linux, async (t) => {
	const { local, trial } = await provision(t, "whisper_backend_init_gpu: using Vulkan");
	const fixture = await stageFixture(local, "immediate", Buffer.alloc(640));
	const take = validateTake(await collect({ ...trial, ...fixture }, t.signal, { local }));
	assert.equal(take.outcome, "unavailable");
	assert.equal(take.gaps[0].code, "identity-mismatch");
	assert.match(take.gaps[0].detail, /planned CPU backend/);
});

test("Pi collector refuses to grade a new process as an idle model reload", linux, async (t) => {
	const { local, trial } = await provision(t);
	const fixture = await stageFixture(local, "continuous", Buffer.alloc(128_000, 1));
	const take = validateTake(await collect({ ...trial, ...fixture, cache: "idle-reload" }, t.signal, { local }));
	assert.equal(take.outcome, "unavailable");
	assert.deepEqual(take.events, []);
	assert.equal(take.gaps[0].code, "unsupported");
	assert.match(take.gaps[0].detail, /idle.reload/);
});

test("Pi collector refuses a display or recorder identity the isolated route cannot establish", linux, async (t) => {
	const { local, trial } = await provision(t);
	const fixture = await stageFixture(local, "immediate", Buffer.alloc(640));
	for (const [field, value] of [["display", "Wayland"], ["mic", "physical input"]]) {
		const take = validateTake(await collect({ ...trial, ...fixture, rig: { ...trial.rig, [field]: value } }, t.signal, { local }));
		assert.equal(take.outcome, "unavailable");
		assert.deepEqual(take.events, []);
		assert.equal(take.gaps[0].code, "identity-mismatch");
		assert.match(take.gaps[0].detail, new RegExp(`planned ${field}`));
	}
});

test("disposable Pi observes extension send and queue attempts without forwarding them to Pi input", linux, async (t) => {
	const root = await workspace(t);
	const entry = join(root, "attempt.mjs");
	await writeFile(entry, `export default (pi) => pi.on('session_start', () => {
		pi.sendUserMessage('Public input fixture');
		pi.sendUserMessage('Public queue fixture', { deliverAs: 'followUp' });
	});`);
	const state = await isolatedPi({ root, entry, signal: t.signal });
	try {
		const pi = observedPi(state, installedPi, 80, t.signal);
		await waitFor(async () => (await traceRows(state.trace)).filter(({ kind }) => kind === "send").length === 2, t.signal,
			"Pi did not reach both extension send attempts");
		enterCommand(pi, "/quit");
		assert.equal((await pi.close).code, 0);
		const traces = await traceRows(state.trace);
		assert.deepEqual(traces.filter(({ kind }) => kind === "send").map(({ queued }) => queued), [false, true]);
		assert.ok(!traces.some(({ kind }) => kind === "blocked-input"), "extension sends escaped the replay harness into the host input handler");
	} finally { await closePi(state); }
});
