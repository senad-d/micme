import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

const { buildLiveWorkerCommand, caughtUpForLivePreview, LiveTranscript, LiveWorker } = await import("../src/streaming.ts");

const ready = { type: "ready", version: 1, rate: 16000, loadMs: 12.5, asrLoads: 1, vadLoads: 1 };
const cleanExit = { code: 0, signal: null };
const shortPcm = Buffer.from([13, 10, 128, 255, 0, 0, 3, 0]);
const textEvent = (type, from, to, text) => ({ type, from, to, text });
const done = (through) => ({ type: "done", through, asrCalls: 1, asrMs: 5, vadFrames: 1 });
const plan = { binary: "/path/micme-live", modelPath: "/path/asr weight.bin", vadModelPath: "/path/vad.bin", language: "es", translate: true };

function protocolHarness(t, timeoutMs = 1000) {
	const controller = new AbortController();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const chunks = [];
	const updates = [];
	stdin.on("data", (chunk) => chunks.push(chunk));
	const observed = Promise.withResolvers();
	const closed = Promise.withResolvers();
	const worker = new LiveWorker({ process: { stdin, stdout }, exitObserved: observed.promise, exitPromise: closed.promise }, controller.signal, (event) => updates.push(event), timeoutMs);
	t.after(() => controller.abort());
	return { controller, worker, chunks, updates, stdout, observed, closed, emit: (...events) => stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n") };
}

test("launch uses only Worker v1 argv; backlog preserves data while suppressing speculative decode", () => {
	assert.equal(buildLiveWorkerCommand(plan).command, plan.binary);
	assert.deepEqual(buildLiveWorkerCommand(plan).args, ["--model", plan.modelPath, "--vad-model", plan.vadModelPath, "--language", "es", "--translate"]);
	assert.equal(caughtUpForLivePreview(16002, 1), false);
	assert.equal(caughtUpForLivePreview(16002, 2), true);
});

test("passive OpenMP waits default only in the live child without overriding an explicit policy", (t) => {
	const saved = process.env.OMP_WAIT_POLICY;
	t.after(() => {
		if (saved === undefined) delete process.env.OMP_WAIT_POLICY;
		else process.env.OMP_WAIT_POLICY = saved;
	});
	delete process.env.OMP_WAIT_POLICY;
	assert.equal(buildLiveWorkerCommand(plan).spawnOptions.env.OMP_WAIT_POLICY, "PASSIVE");
	assert.equal(process.env.OMP_WAIT_POLICY, undefined);
	process.env.OMP_WAIT_POLICY = "ACTIVE";
	assert.equal(buildLiveWorkerCommand(plan).spawnOptions, undefined);
});

test("Worker v1 reassembles split UTF-8, bounds the PCM exchange, and publishes finals only after matching responses", async (t) => {
	const { worker, stdout, emit, updates, chunks, observed, closed } = protocolHarness(t);
	emit(ready);
	assert.deepEqual(await worker.ready, { loadMs: ready.loadMs, asrLoads: 1, vadLoads: 1 });
	const first = worker.send(shortPcm, true);
	const draft = textEvent("partial", 0, 4, "first guess å 😀");
	const bytes = Buffer.from(`${JSON.stringify(draft)}\n`);
	const split = bytes.indexOf(Buffer.from("😀")) + 2;
	stdout.write(bytes.subarray(0, split));
	stdout.write(bytes.subarray(split));
	assert.deepEqual(updates, []);
	assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.of(1, 4, 0, 0, 0), shortPcm]));
	await assert.rejects(worker.send(shortPcm, false), /already in flight/);
	emit({ type: "ack", through: 4 });
	await first;
	assert.deepEqual(updates, [draft]);

	const second = worker.send(shortPcm, true);
	const correction = textEvent("partial", 0, 8, "different guess");
	emit(correction, { type: "ack", through: 8 });
	await second;
	assert.deepEqual(updates, [draft, correction]);

	const catchingUp = worker.send(shortPcm, false);
	const endpoint = textEvent("final", 0, 8, "Okay.");
	emit(endpoint, { type: "ack", through: 12 });
	await catchingUp;
	assert.deepEqual(chunks[2], Buffer.concat([Buffer.of(2, 4, 0, 0, 0), shortPcm]));
	assert.deepEqual(updates, [draft, correction, endpoint]);

	const finishing = worker.finish();
	assert.deepEqual(chunks[3], Buffer.of(3));
	const repeated = textEvent("final", 8, 12, "Okay.");
	emit(repeated, done(12));
	assert.deepEqual(updates, [draft, correction, endpoint]);
	stdout.end();
	observed.resolve(cleanExit);
	closed.resolve(cleanExit);
	assert.equal((await finishing).through, 12);
	assert.deepEqual(updates, [draft, correction, endpoint, repeated]);
});

test("wrong ready version fails before any PCM input", async (t) => {
	const { worker, emit, chunks } = protocolHarness(t);
	emit({ ...ready, version: 2 });
	await assert.rejects(worker.ready, /expected Worker v1/);
	assert.deepEqual(chunks, []);
});

for (const [name, output, error] of [
	["invalid UTF-8", Buffer.of(0xff, 10), /invalid UTF-8 or JSON/],
	["malformed JSON", Buffer.from("{bad}\n"), /invalid UTF-8 or JSON/],
	["oversized line lacking a newline", Buffer.alloc(64 * 1024, 65), /exceeds the 64 KiB/],
	["out-of-range final", textEvent("final", 4, 5, "not fed"), /invalid text event/],
	["invalid Unicode scalar", textEvent("partial", 0, 4, "\ud800"), /invalid text event/],
	["wrong acknowledgment", { type: "ack", through: 2 }, /unexpected PCM acknowledgment/],
]) {
	test(`${name} discards the unacknowledged batch`, async (t) => {
		const { worker, emit, stdout, updates } = protocolHarness(t);
		emit(ready);
		await worker.ready;
		const feed = worker.send(shortPcm, true);
		emit(textEvent("final", 0, 3, "unacknowledged"));
		if (Buffer.isBuffer(output)) stdout.write(output);
		else emit(output);
		await assert.rejects(feed, error);
		assert.deepEqual(updates, []);
	});
}

test("stale or overlapping text cannot supersede a committed audio range", async (t) => {
	const { worker, emit, updates } = protocolHarness(t);
	emit(ready);
	await worker.ready;
	const first = worker.send(shortPcm, false);
	const final = textEvent("final", 0, 4, "first");
	emit(final, { type: "ack", through: 4 });
	await first;
	const next = worker.send(shortPcm, true);
	emit(textEvent("partial", 3, 8, "stale"));
	await assert.rejects(next, /invalid text event/);
	assert.deepEqual(updates, [final]);
});

test("a stale redraw of the same unfrozen samples is not a new draft", async (t) => {
	const { worker, emit } = protocolHarness(t);
	emit(ready);
	await worker.ready;
	const feed = worker.send(shortPcm, true);
	emit(textEvent("partial", 0, 4, "draft"), textEvent("partial", 0, 4, "duplicate"));
	await assert.rejects(feed, /stale partial/);
});

test("non-speculative frames cannot produce a partial", async (t) => {
	const { worker, emit, updates } = protocolHarness(t);
	emit(ready);
	await worker.ready;
	const feed = worker.send(shortPcm, false);
	emit(textEvent("partial", 0, 4, "not during catch-up"));
	await assert.rejects(feed, /invalid text event/);
	assert.deepEqual(updates, []);
});

test("done must match the complete sample count", async (t) => {
	const { worker, emit, updates } = protocolHarness(t);
	emit(ready);
	await worker.ready;
	const finish = worker.finish();
	emit(done(1));
	await assert.rejects(finish, /unexpected done event or sample count/);
	assert.deepEqual(updates, []);
});

test("successful done followed by a failed exit does not publish finish-only text", async (t) => {
	const { worker, emit, observed, updates } = protocolHarness(t);
	emit(ready);
	await worker.ready;
	const feed = worker.send(shortPcm, false);
	emit({ type: "ack", through: 4 });
	await feed;
	const finish = worker.finish();
	emit(textEvent("final", 0, 4, "do not publish"), done(4));
	observed.resolve({ code: 7, signal: null });
	await assert.rejects(finish, /exited unexpectedly \(code 7\)/);
	assert.deepEqual(updates, []);
});

test("unexpected clean worker exit cancels an acknowledgment even with stdout still open", async (t) => {
	const { worker, emit, observed } = protocolHarness(t);
	emit(ready);
	await worker.ready;
	const feed = worker.send(shortPcm, true);
	observed.resolve(cleanExit);
	await assert.rejects(feed, /exited unexpectedly \(code 0\)/);
});

for (const phase of ["ready", "acknowledgment", "finish and worker exit"]) {
	test(`a hung ${phase} has a bounded lifetime`, async (t) => {
		const { worker, emit } = protocolHarness(t, 25);
		if (phase === "ready") await assert.rejects(worker.ready, /timed out waiting for ready/);
		else {
			emit(ready);
			await worker.ready;
			const pending = phase === "acknowledgment" ? worker.send(shortPcm, true) : worker.finish();
			await assert.rejects(pending, new RegExp(`timed out waiting for .*${phase}`));
		}
		assert.equal(worker.signal.aborted, true);
	});
}

test("operation abort settles a pending frame without publishing late text", async (t) => {
	const { worker, emit, controller, updates } = protocolHarness(t);
	emit(ready);
	await worker.ready;
	const feed = worker.send(shortPcm, true);
	controller.abort();
	emit(textEvent("final", 0, 4, "late"), { type: "ack", through: 4 });
	await assert.rejects(feed, { name: "AbortError" });
	assert.deepEqual(updates, []);
});

test("confirmed spans preserve repetitions and observed editor edits without replacement", () => {
	let editor = "existing";
	const notices = [];
	const ctx = {
		mode: "tui",
		ui: { getEditorText: () => editor, setEditorText: (text) => { editor = text; }, notify: (message) => notices.push(message) },
	};
	const transcript = new LiveTranscript(ctx);
	transcript.commit("Okay.");
	editor += "inserted";
	transcript.commit("Okay.");
	assert.equal(transcript.text, "Okay. Okay.");
	transcript.deliver({ sendUserMessage: () => assert.fail("editor edit must suppress send") }, "refined", true);
	assert.equal(editor, "existing Okay. inserted Okay. ");
	assert.match(notices[0], /editor was edited/);
});
