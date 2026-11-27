// Off-by-default component observations; integrated P4 uses the common B runner instead.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getCatalogVariant, referenceClaim } from "../../src/transfer/catalog.ts";
import { listCompute, loadEngine } from "../../src/transfer/engine.ts";
import { sha256 } from "../../test/live-native/corpus.mjs";
import { wordErrors } from "../../test/live-native/scoring.mjs";

const [recognizerFile, recognizerSha256, inputDir] = process.argv.slice(2);
if (process.argv.length !== 5) throw new Error("Usage: node native/recognizer/smoke.mjs ABS_RECOGNIZER SHA256 ABS_INPUT_DIR");
const helper = { recognizerFile, recognizerSha256 };
const signal = new AbortController().signal;
const jfk = { pcm: await fixture("jfk.pcm", "a29462b8ebd467318000e683b9117ade46230d3255ed2024e7db894abd9b38c9"),
	text: "And so my fellow Americans ask not what your country can do for you ask what you can do for your country." };
const french = await fixture("french.pcm", "7022b3441e8523fa5ae2f7f9b12588e2ed5f960664e597c81cf2fd648e1739df");
const noiseBlock = await fixture("rain.pcm", "eb321b86e5f84e1e24929f4b3e7c51194fdc834257a7a062e77930b6dc3a95c7");
const noise = Buffer.concat([noiseBlock, noiseBlock]);
const zero = Buffer.alloc(32000);

async function fixture(file, pin) {
	const pcm = await readFile(join(inputDir, file));
	assert.equal(sha256(pcm), pin);
	return pcm;
}

async function rss(engine) {
	const status = await readFile(`/proc/${engine.pid}/status`, "utf8");
	return Number(status.match(/^VmRSS:\s+(\d+)/m)[1]) * 1024;
}

function inputMatches(engine, pcm) {
	const evidence = engine.evidence();
	assert.equal(evidence.inputPcmSha256, sha256(pcm));
	assert.equal(evidence.inputSamples, pcm.length / 2);
	return evidence;
}

async function stream(engine, pcm, started, paced) {
	const speech = [];
	for (let cursor = 0; cursor < pcm.length / 2;) {
		const next = Math.min(pcm.length / 2, cursor + 5120);
		if (paced) await delay(Math.max(0, next / 16 - (performance.now() - started)));
		const updates = await engine.feed(cursor, pcm.subarray(cursor * 2, next * 2), false, signal);
		for (const update of updates) speech.push({ ms: Math.round(performance.now() - started), ...update });
		cursor = next;
	}
	const stopMs = Math.round(performance.now() - started);
	const [final] = await engine.feed(pcm.length / 2, Buffer.alloc(0), true, signal);
	return { stopMs, speech, final, evidence: inputMatches(engine, pcm) };
}

async function batch(engine, pcm, language) {
	const start = performance.now();
	const text = await engine.batch(pcm, language, signal);
	return { ms: Math.round(performance.now() - start), text, evidence: inputMatches(engine, pcm) };
}

async function rejects(choice, provision, reason) {
	await assert.rejects(loadEngine(choice, signal, provision), reason);
	return reason.source;
}

async function observe(catalog, quant, role) {
	const id = referenceClaim(catalog).variants.find((v) => v.quant === quant).id;
	const [blob] = getCatalogVariant(id).blobs;
	let wire = [];
	let clock = performance.now();
	const provision = { ...helper, engineModelFiles: [{ variantId: id, blobPath: blob.path, file: join(inputDir, blob.path), sha256: blob.sha256 }],
		observe: (event) => wire.push({ ms: Math.round(performance.now() - clock), ...event }) };
	const choice = { variantId: id, compute: "cpu", requestedDeviceId: null, language: "en", task: "transcribe", detector: "off", chunking: true };
	const coldStart = performance.now();
	const engine = await loadEngine(choice, signal, provision);
	const cold = { ms: Math.round(performance.now() - coldStart), rssBytes: await rss(engine), counters: engine.evidence() };
	const result = { id, blob, role, traits: engine.traits, threads: engine.threads, maxInputSamples: engine.maxInputSamples, cold };
	assert.equal(engine.traits.actualCompute, "cpu");
	assert.equal(engine.traits.stream, role === "stream");
	try {
		if (role === "stream") {
			await engine.begin("en", [], signal);
			clock = performance.now();
			const english = await stream(engine, jfk.pcm, clock, true);
			assert.ok(english.speech.filter((x) => /fellow Americans|your country/i.test(x.text) && x.ms < english.stopMs).length >= 2);
			result.english = { ...english, wire, errors: wordErrors(jfk.text, english.final.text), rssBytes: await rss(engine) };
			wire = [];
			result.comparator = await batch(engine, jfk.pcm, "en");
			result.comparator.errors = wordErrors(jfk.text, result.comparator.text);
			const warm = performance.now();
			await engine.reset(signal);
			await engine.begin("en", [], signal);
			clock = performance.now();
			const silence = await stream(engine, zero, clock, false);
			result.silence = { ...silence, wire, warmMs: Math.round(performance.now() - warm), rssBytes: await rss(engine) };
			assert.equal(silence.final.text, "");
			assert.equal(silence.evidence.asrCalls, result.comparator.evidence.asrCalls);
			wire = [];
			await engine.reset(signal);
			await engine.begin("en", [], signal);
			clock = performance.now();
			result.noise = { ...await stream(engine, noise, clock, false), wire };
		} else {
			result.english = await batch(engine, jfk.pcm, "en");
			result.english.errors = wordErrors(jfk.text, result.english.text);
			result.english.rssBytes = await rss(engine);
			const warm = performance.now();
			await engine.reset(signal);
			result.french = await batch(engine, french, "fr");
			result.french.errors = wordErrors("Paris", result.french.text);
			result.french.warmMs = Math.round(performance.now() - warm);
			result.silence = await batch(engine, zero, "en");
			assert.equal(result.silence.text, "");
			assert.equal(result.silence.evidence.asrCalls, result.french.evidence.asrCalls);
			result.noise = await batch(engine, noise, "en");
		}
		assert.ok(result.english.errors.wer <= 0.2);
	} finally {
		const start = performance.now();
		await engine.close();
		result.unload = { ms: Math.round(performance.now() - start), ...engine.evidence() };
		assert.ok(result.unload.workerCleanExit);
	}
	result.rejections = [
		await rejects({ ...choice, language: role === "stream" ? "fr" : "ja" }, provision, /does not support the selected language/),
		await rejects({ ...choice, task: "translate-en" }, provision, /does not support translation/),
		await rejects({ ...choice, detector: "silero" }, provision, /does not support the selected speech detector/),
		await rejects({ ...choice, requestedDeviceId: "not-a-runtime-device" }, provision, /device is unavailable/),
	];
	const killed = await loadEngine(choice, signal, provision);
	process.kill(killed.pid, "SIGKILL");
	await assert.rejects(killed.batch(jfk.pcm, "en", signal));
	await killed.close();
	assert.throws(() => process.kill(killed.pid, 0), { code: "ESRCH" });
	const reload = performance.now();
	const next = await loadEngine(choice, signal, provision);
	const reloadMs = Math.round(performance.now() - reload);
	try {
		const landed = await batch(next, jfk.pcm, "en");
		assert.match(landed.text, /fellow Americans/i);
		result.killThenNext = { reaped: true, cleanExit: killed.evidence().workerCleanExit, reloadMs, next: landed };
	} finally {
		await next.close();
	}
	return result;
}

const evidence = {
	binarySha256: recognizerSha256, devices: await listCompute(helper, signal),
	components: [await observe("moonshine-streaming-tiny", "Q8_0", "stream"),
		await observe("parakeet-tdt-0.6b-v3", "Q4_K_M", "batch")],
};
console.log(JSON.stringify(evidence));
