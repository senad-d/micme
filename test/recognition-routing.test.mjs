import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createRecognitionService } from "../src/transfer/recognition.ts";
import { RecognitionQueue } from "../src/transfer/jobs.ts";
import { wavHeader } from "./live-native/corpus.mjs";

const base = { variantId: "unit-exact-model", compute: "auto", requestedDeviceId: null, task: "transcribe", language: "en", detector: "off", chunking: true };
const signal = new AbortController().signal;
const discard = () => {};
const waveform = Buffer.from([3, 0, 5, 0, 7, 0, 11, 0]);
const label = { id: "vulkan-b", label: "Measured device B" };
const traits = { stream: false, batch: true, longForm: false, nativeLid: false, bias: false, translateEn: false, languages: ["en"],
	vad: "off", actualCompute: "vulkan", boundDevice: label };
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

function audio(pcm, expected = null) {
	const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
	return { bytes: wav.length, sha256: expected ?? sha(wav), copyTo: async (dir) => {
		const path = join(dir.filesPath, "verified.wav");
		const fd = dir.createPrivateFile(path);
		try { writeFileSync(fd, wav); } finally { closeSync(fd); }
		return path;
	} };
}

class FakeNative {
	traits;
	closed = false;
	started = false;
	maxInputSamples = 120 * 16_000;
	pid = 1;
	binarySha256 = "0".repeat(64);
	threads = 4;
	blocks = [];
	calls = 0;
	batchText;
	rejectRun = false;
	rejectReset = false;

	constructor(overrides = {}, batchText = () => "verified final") { this.traits = { ...traits, ...overrides }; this.batchText = batchText; }
	async begin() { assert.equal(this.started, false); this.started = true; }
	async feed(from, pcm, last) {
		this.blocks.push(pcm);
		if (last) return [{ kind: "commit", from: 0, to: from, text: "verified final" }];
		return [{ kind: "draft", from: 0, to: from + pcm.length / 2, text: "verified draft" }];
	}
	async batch(pcm) {
		if (this.rejectRun) throw new Error("native returned an error");
		this.blocks = [pcm];
		return this.batchText(++this.calls);
	}
	async reset() {
		if (this.rejectReset) throw new Error("native could not reset");
		this.started = false;
		this.blocks = [];
	}
	async close() { this.closed = true; }
	evidence() {
		const pcm = Buffer.concat(this.blocks);
		return { inputSamples: pcm.length / 2, inputPcmSha256: sha(pcm), asrCalls: this.calls, asrLoads: 1, vadLoads: 0,
			peakRssBytes: null, workerCleanExit: this.closed };
	}
}

function service(load, extra = {}) {
	return createRecognitionService({ load, settings: () => ({ MICME_MODEL_IDLE: "immediate", MICME_PREFERRED_LANGUAGES: [], MICME_WORDS: [] }), ...extra });
}

async function finishTake(recognizer, pcm, active = signal) {
	await recognizer.push(0, pcm, active);
	return recognizer.finish(audio(pcm), active);
}

test("the loaded stream emits drafts and returns only its exact verified end as a commit", async () => {
	const updates = [];
	const engine = new FakeNative({ stream: true });
	const api = service(async () => engine);
	const rec = await api.openRecognizer(base, (update) => updates.push(update), signal);
	await rec.push(0, waveform, signal);
	assert.deepEqual(updates.map(({ kind }) => kind), ["draft"]);
	const final = await rec.finish(audio(waveform), signal);
	assert.equal(final.raw, "verified final");
	assert.deepEqual(updates.map(({ kind, to }) => [kind, to]), [["draft", 4], ["commit", 4]]);
	assert.equal(engine.closed, true);
});

test("a saturated PCM read is acknowledged as catch-up without publishing its stale draft", async () => {
	const engine = new FakeNative({ stream: true });
	const feed = engine.feed.bind(engine);
	const catches = [];
	engine.feed = (from, pcm, last, active, catchUp) => {
		if (!last) catches.push(catchUp);
		return feed(from, pcm, last, active);
	};
	const updates = [];
	const api = service(async () => engine);
	const rec = await api.openRecognizer(base, (update) => updates.push(update), signal);
	const backlog = Buffer.alloc(32_000, 12);
	await rec.push(0, backlog, signal);
	await rec.push(16_000, waveform, signal);
	assert.equal((await rec.finish(audio(Buffer.concat([backlog, waveform])), signal)).raw, "verified final");
	assert.deepEqual(catches, [true, false]);
	assert.deepEqual(updates.map(({ kind, to }) => [kind, to]), [["draft", 16_004], ["commit", 16_004]]);
});

test("a different complete snapshot cannot finalize or publish an in-flight stream", async () => {
	const updates = [];
	const engine = new FakeNative({ stream: true });
	const rec = await service(async () => engine).openRecognizer(base, (update) => updates.push(update), signal);
	await rec.push(0, waveform, signal);
	await assert.rejects(rec.finish(audio(Buffer.alloc(waveform.length)), signal), /does not match the PCM supplied/);
	assert.ok(updates.every(({ kind }) => kind === "draft"));
	assert.ok(engine.closed);
});

test("batch-only routing emits no draft or editor commit and returns actual file-run binding", async () => {
	const updates = [];
	const api = service(async () => new FakeNative());
	const rec = await api.openRecognizer(base, (update) => updates.push(update), signal);
	assert.equal((await finishTake(rec, waveform)).raw, "verified final");
	assert.deepEqual(updates, []);
	const result = await api.recognizeFile(audio(waveform), base, "cli", discard, signal);
	assert.equal(result.raw, "verified final");
	assert.equal(result.actualCompute, "vulkan");
	assert.deepEqual(result.boundDevice, label);
});

test("a loaded long-form adapter receives the complete verified take instead of chunk calls", async () => {
	const verified = audio(waveform);
	const engine = new FakeNative({ batch: false, longForm: true });
	engine.batchFile = async (receipt) => { assert.equal(receipt, verified); return "native long final"; };
	const rec = await service(async () => engine).openRecognizer(base, discard, signal);
	await rec.push(0, waveform, signal);
	assert.equal((await rec.finish(verified, signal)).raw, "native long final");
	assert.equal(engine.calls, 0);
});

test("disabling batch chunking runs one bounded whole-take decode", async () => {
	const pcm = Buffer.alloc(41 * 32_000, 13);
	const engine = new FakeNative();
	const rec = await service(async () => engine).openRecognizer({ ...base, chunking: false }, discard, signal);
	await finishTake(rec, pcm);
	assert.equal(engine.calls, 1);
	assert.equal(engine.evidence().inputPcmSha256, sha(pcm));
});

test("a noncontiguous feed ends the take rather than filling a gap or committing", async () => {
	const engine = new FakeNative({ stream: true });
	const rec = await service(async () => engine).openRecognizer(base, () => assert.fail("published from a gapped feed"), signal);
	await assert.rejects(rec.push(1, waveform, signal), /contiguous/);
	assert.ok(engine.closed);
});

test("canceling a take while the engine is finalizing suppresses its late commit", async () => {
	const cancel = new AbortController();
	const engine = new FakeNative({ stream: true });
	const feed = engine.feed.bind(engine);
	engine.feed = async (from, pcm, last) => {
		if (last) cancel.abort(new Error("take canceled"));
		return feed(from, pcm, last);
	};
	const updates = [];
	const rec = await service(async () => engine).openRecognizer(base, (update) => updates.push(update), cancel.signal);
	await assert.rejects(finishTake(rec, waveform, cancel.signal), /take canceled/);
	assert.deepEqual(updates.map(({ kind }) => kind), ["draft"]);
	assert.ok(engine.closed);
});

test("the loaded device must be the exact selected ID, not just the backend family", async () => {
	const engine = new FakeNative();
	const api = service(async () => engine);
	await assert.rejects(api.openRecognizer({ ...base, compute: "vulkan", requestedDeviceId: "vulkan-a" }, discard, signal), /does not match/);
	assert.ok(engine.closed);
});

test("bounded chunks cut in a pause without duplicating or dropping samples and keep intentional repeats", async () => {
	const pcm = Buffer.alloc(45 * 32_000, 12);
	pcm.fill(0, 29 * 32_000, 31 * 32_000);
	const calls = [];
	const batches = new FakeNative({}, () => "again");
	const api = service(async () => batches, { observe: (e) => { if (e.kind === "batch") calls.push(e); } });
	const result = await api.recognizeFile(audio(pcm), { ...base, chunking: false }, "import", discard, signal);
	assert.equal(result.raw, "again again");
	assert.equal(calls.length, 2);
	assert.ok(calls[0].to > 29 * 16_000 && calls[0].to < 31 * 16_000);
	assert.equal(calls[0].to, calls[1].from);
	assert.equal(calls[1].to, pcm.length / 2);
	for (const { from, to, evidence } of calls) assert.equal(evidence.inputPcmSha256, sha(pcm.subarray(from * 2, to * 2)));
});

test("chunk seams join CJK without an added space", async () => {
	const pcm = Buffer.alloc(81 * 32_000, 12);
	const fragments = ["東京", "駅。", "𠮷野"];
	const api = service(async () => new FakeNative({}, (call) => fragments[call - 1]));
	assert.equal((await api.recognizeFile(audio(pcm), base, "import", discard, signal)).raw, "東京駅。𠮷野");
});

test("a bad verified file digest fails before loading any engine or retrying", async () => {
	const api = service(() => assert.fail("loaded before verifying the complete WAV"));
	await assert.rejects(api.recognizeFile(audio(waveform, "f".repeat(64)), base, "retry", discard, signal, {
		onCpuRecovery: () => assert.fail("retry on corrupt audio"),
	}), /digest/);
});

test("same-audio retry uses one fresh engine, then at most one announced CPU attempt for Auto", async () => {
	const attempts = [];
	const api = service(async ({ compute }) => {
		attempts.push(compute);
		const engine = new FakeNative(compute === "cpu" ? { actualCompute: "cpu", boundDevice: null } : {});
		engine.rejectRun = compute === "auto";
		return engine;
	});
	const result = await api.recognizeFile(audio(waveform), base, "retry", discard, signal, { onCpuRecovery: () => attempts.push("announced") });
	assert.equal(result.actualCompute, "cpu");
	assert.equal(result.boundDevice, null);
	assert.deepEqual(attempts, ["auto", "announced", "cpu"]);
});

test("a pinned device failure never changes the requested binding on retry", async () => {
	let loads = 0;
	const api = service(async () => {
		loads++;
		const engine = new FakeNative();
		engine.rejectRun = true;
		return engine;
	});
	await assert.rejects(api.recognizeFile(audio(waveform), { ...base, requestedDeviceId: label.id }, "retry", discard, signal, {
		onCpuRecovery: () => assert.fail("fallback on a pinned device"),
	}), /inference failed/);
	assert.equal(loads, 1);
});

test("cancellation during the first attempt suppresses the CPU attempt and a late final", async () => {
	const cancel = new AbortController();
	const api = service(async ({ compute }) => {
		assert.equal(compute, "auto");
		return new FakeNative({}, () => { cancel.abort(new Error("user canceled")); return "late"; });
	});
	await assert.rejects(api.recognizeFile(audio(waveform), base, "retry", () => assert.fail("late progress"), cancel.signal, {
		onCpuRecovery: () => assert.fail("fallback after cancellation"),
	}), /user canceled/);
});

test("warm engines are reused only after reset; explicit unload leaves the next take cold", async () => {
	const built = [];
	const api = service(async () => { const engine = new FakeNative({ stream: true }); built.push(engine); return engine; }, {
		settings: () => ({ MICME_MODEL_IDLE: "never", MICME_PREFERRED_LANGUAGES: [], MICME_WORDS: [] }),
	});
	const take = async () => finishTake(await api.openRecognizer(base, discard, signal), waveform);
	await take(); await take();
	assert.equal(built.length, 1);
	assert.equal(built[0].closed, false);
	await api.unload();
	assert.ok(built[0].closed);
	await take();
	assert.equal(built.length, 2);
	await api.unload();
});

test("the five-minute idle timeout unloads a reset engine without another take", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const engine = new FakeNative();
	const api = service(async () => engine, { settings: () => ({ MICME_MODEL_IDLE: "5min", MICME_PREFERRED_LANGUAGES: [], MICME_WORDS: [] }) });
	await finishTake(await api.openRecognizer(base, discard, signal), waveform);
	t.mock.timers.tick(299_999);
	assert.equal(engine.closed, false);
	t.mock.timers.tick(1);
	assert.equal(engine.closed, true);
	await api.unload();
});

test("a reset error discards the engine instead of restoring its previous stream state", async () => {
	const engines = [];
	const api = service(async () => {
		const engine = new FakeNative({ stream: true });
		engine.rejectReset = engines.length === 0;
		engines.push(engine);
		return engine;
	}, { settings: () => ({ MICME_MODEL_IDLE: "never", MICME_PREFERRED_LANGUAGES: [], MICME_WORDS: [] }) });
	await finishTake(await api.openRecognizer(base, discard, signal), waveform);
	assert.ok(engines[0].closed);
	await finishTake(await api.openRecognizer(base, discard, signal), waveform);
	assert.equal(engines.length, 2);
	await api.unload();
});

test("foreground takes wait for one active chunk and retries overtake queued imports", async () => {
	const queue = new RecognitionQueue();
	const observed = [];
	const first = await queue.acquire("import", signal);
	const input = queue.acquire("import", signal).then((release) => { observed.push("import"); release(); });
	const retry = queue.acquire("retry", signal).then((release) => { observed.push("retry"); release(); });
	queue.setForeground(true);
	const take = queue.acquire("foreground", signal).then((release) => { observed.push("take"); release(); });
	assert.deepEqual(observed, []);
	first();
	await take;
	assert.deepEqual(observed, ["take"]);
	queue.setForeground(false);
	await Promise.all([input, retry]);
	assert.deepEqual(observed, ["take", "retry", "import"]);
});

test("CLI file calls do not join the Pi foreground queue", async () => {
	const queue = new RecognitionQueue();
	queue.setForeground(true);
	const api = service(async () => new FakeNative(), { queue });
	const result = await api.recognizeFile(audio(waveform), base, "cli", discard, AbortSignal.timeout(1_000));
	assert.equal(result.raw, "verified final");
});

test("a canceled queued job does not retain its inference lease", async () => {
	const queue = new RecognitionQueue();
	queue.setForeground(true);
	const cancel = new AbortController();
	const old = queue.acquire("retry", cancel.signal);
	cancel.abort(new Error("job canceled"));
	await assert.rejects(old, /job canceled/);
	const next = queue.acquire("import", signal);
	queue.setForeground(false);
	(await next)();
});
