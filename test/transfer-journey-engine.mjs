import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fullInput, publicText, sha } from "./transfer-journey-fixtures.mjs";

// Process-local stand-ins for M inventory, measured qualification, and the native
// E transport only. The Pi extension, configured choices, managed cache, loaded
// trait routing, capture, finish decisions, and library are not replaced.
const device1 = { id: "fixture-vulkan-1", label: "Fixture device A" };
const device2 = { id: "fixture-vulkan-2", label: "Fixture device B" };
const bytes = Buffer.from("Public deterministic artifact; not model weights.\n");
const revision = "a".repeat(40);
const blob = { url: `https://huggingface.co/micme-fixture/public-test/resolve/${revision}/model.bin`, revision, path: "model.bin", bytes: bytes.length, sha256: sha(bytes) };
const common = { quant: "fixture", blobs: [blob], baseRevision: revision, conversion: "fixture", terms: "public fixture", attribution: "Micme test fixture",
	rights: "cleared", runtime: "passed", languages: ["fr", "de"], reason: null };
const traits = { batch: true, nativeLid: false, bias: false, translateEn: true, languages: common.languages, vad: "native", actualCompute: "vulkan", boundDevice: device2 };
const streaming = { ...common, id: "fixture-stream-v1", traits: { ...traits, stream: true, longForm: false, nativeLid: true, bias: true, translateEn: false },
	measurements: [{ feature: "A4", language: "fr", task: "transcribe", rig: "fixture", device: device2, wer: null, cer: null, xrt: null, evidence: "scripted V4 only", disposition: "adapted-verified" }] };
const batch = { ...common, id: "fixture-batch-v1", traits: { ...traits, stream: false, longForm: false },
	measurements: [{ feature: "A4", language: "fr", task: "translate-en", rig: "fixture", device: device2, wer: null, cer: null, xrt: null, evidence: "scripted V4 only", disposition: "adapted-verified" }] };
const variants = [streaming, batch];
let engineState;

export const referenceRows = () => variants.map((variant) => ({ id: variant.id, label: `Public ${variant.traits.stream ? "stream" : "batch"} fixture`, curated: true, variants: [variant] }));
export const getEngineEvidence = (id) => {
	const row = variants.find((variant) => variant.id === id);
	return row ? { runtime: row.runtime, traits: row.traits, measurements: row.measurements } : null;
};
export const listCompute = async () => [device1, device2].map((device) => ({ backend: "vulkan", device }));
export const detectBatchLanguage = async (_audio, allowed, signal) => {
	signal.throwIfAborted();
	engineState.events.push({ kind: "lid", allowed });
	return "fr";
};
export async function loadEngine(choice, signal) {
	signal.throwIfAborted();
	const variant = variants.find((row) => row.id === choice.variantId);
	assert.ok(variant, `fixture does not simulate the requested engine: ${choice.variantId}`);
	const { events, wrongBinding } = engineState;
	const boundDevice = wrongBinding ? device1 : device2;
	events.push({ kind: "load", choice, boundDevice });
	let blocks = [];
	return {
		traits: { ...variant.traits, boundDevice },
		begin: async (language, words, operation) => { operation.throwIfAborted(); events.push({ kind: "begin", language, words: [...words] }); },
		feed: async (from, pcm, last, operation) => {
			operation.throwIfAborted();
			blocks.push(Buffer.from(pcm));
			const to = from + pcm.length / 2;
			events.push({ kind: "feed", from, to, last });
			if (!last) return [];
			const all = Buffer.concat(blocks);
			events.push({ kind: "stream-final", sha256: sha(all), length: all.length });
			return [{ kind: "commit", from: 0, to, text: publicText }];
		},
		batch: async (pcm, language, operation) => {
			operation.throwIfAborted();
			events.push({ kind: "batch", language, sha256: sha(pcm), length: pcm.length });
			return publicText;
		},
		reset: async () => { blocks = []; },
		close: async () => {},
	};
}

function fixtureModules() {
	const urls = new Set(["catalog", "engine", "engine-evidence"].map((file) => new URL(`../src/transfer/${file}.ts`, import.meta.url).href));
	registerHooks({ resolve(specifier, context, next) {
		const result = next(specifier, context);
		return urls.has(result.url) ? { url: import.meta.url, shortCircuit: true } : result;
	} });
}

async function installManaged(t, variant, corruptFirst = false) {
	const { ensureManaged } = await import("../src/transfer/managed.ts");
	assert.equal(typeof ensureManaged, "function", "M managed artifacts are not implemented yet");
	const calls = [];
	let corrupt = corruptFirst;
	t.mock.method(globalThis, "fetch", (url) => {
		const href = url instanceof Request ? url.url : String(url);
		calls.push(href);
		assert.equal(href, blob.url, "fixture must never receive a different model or host");
		return Promise.resolve(new Response(corrupt ? Buffer.alloc(bytes.length, 11) : bytes, { headers: { "Content-Length": String(bytes.length) } }));
	});
	const signal = new AbortController().signal;
	const ensure = (download) => ensureManaged(variant, download, () => {}, signal);
	if (corruptFirst) {
		await assert.rejects(ensure(true), /(?:digest|hash|verif|quality|integrity|mismatch)/i);
		const fetched = calls.length;
		assert.ok(fetched > 0);
		await assert.rejects(ensure(false), /(?:artifact|missing|verif|corrupt|offline|cache|install)/i);
		assert.equal(calls.length, fetched, "offline resolution tried a transfer after the hash failure");
		corrupt = false;
	}
	const path = await ensure(true);
	await access(path);
	const downloaded = calls.length;
	assert.ok(downloaded > 0);
	const offline = await ensure(false);
	assert.equal(offline, path);
	assert.equal(calls.length, downloaded, "verified offline reuse contacted the network");
	return calls;
}

function assertRoute(events, mode) {
	const loads = events.filter(({ kind }) => kind === "load");
	assert.equal(loads.length, 1, "did not load exactly the selected engine");
	const [{ choice, boundDevice }] = loads;
	assert.deepEqual([choice.compute, choice.requestedDeviceId, choice.language, choice.task], ["vulkan", device2.id, "fr", mode === "native" ? "transcribe" : "translate-en"]);
	assert.deepEqual(boundDevice, device2);
	const expected = { sha256: sha(fullInput), length: fullInput.length };
	if (mode === "native") {
		assert.deepEqual(events.filter(({ kind }) => kind === "begin"), [{ kind: "begin", language: "fr", words: ["Public"] }]);
		assert.deepEqual(events.filter(({ kind }) => kind === "batch"), []);
		const fed = events.filter(({ kind }) => kind === "feed");
		assert.ok(fed.length > 1, "native route did not feed before stop");
		assert.equal(fed[0].from, 0);
		for (let i = 1; i < fed.length; i++) assert.equal(fed[i].from, fed[i - 1].to, "PCM offsets skipped or doubled input");
		assert.equal(fed.at(-1).to, fullInput.length / 2);
		assert.deepEqual(events.filter(({ kind }) => kind === "stream-final"), [{ kind: "stream-final", ...expected }]);
	} else {
		assert.deepEqual(events.filter(({ kind }) => kind === "begin" || kind === "feed"), [], "batch-only adapter took the stream path");
		assert.deepEqual(events.filter(({ kind }) => kind === "batch"), [{ kind: "batch", language: "fr", ...expected }]);
	}
}

async function engineJourney(t, mode) {
	const { isolatedJourney, prompt, until } = await import("./transfer-journey-harness.mjs");
	const variant = mode === "native" ? streaming : batch;
	const f = await isolatedJourney(t);
	await f.configure({ MICME_ARTIFACT: variant.id, MICME_COMPUTE: device2.id, MICME_WHISPER_CPP_MODEL: "",
		MICME_TRANSCRIPTION_MODE: "stream", MICME_STREAM_FINALIZE_WITH_CLIP: "0", MICME_TRANSLATE_TO_ENGLISH: mode === "native" ? "off" : "fr",
		MICME_WORDS: '["Public"]', MICME_HISTORY: mode === "native" ? "1" : "0" });
	const calls = await installManaged(t, variant, mode === "native");
	const transfers = calls.length;
	engineState = { events: [], wrongBinding: false };
	const ui = await f.host({ width: 80 });
	assert.deepEqual(engineState.events, [], "opening Pi loaded an engine");
	assert.deepEqual(await f.events(), [], "opening Pi opened a recorder");
	await ui.command();
	await f.waitEvent("block");
	if (mode === "native") await until(() => engineState.events.some(({ kind, last }) => kind === "feed" && !last), "native recognizer never consumed the initial PCM before stop", ui.diagnostics);
	else assert.deepEqual(engineState.events.filter(({ kind }) => kind === "batch"), [], "batch inference started from a growing WAV");
	await ui.command();
	assertRoute(engineState.events, mode);
	assert.equal(ui.text.trim(), `${prompt}${publicText}`.trim());
	assert.equal(ui.text.split(publicText).length, 2);
	assert.deepEqual(ui.sends, []);
	assert.deepEqual(await f.events("clip"), [], "explicit artifact fell back to Whisper silently");
	assert.deepEqual(await f.events("modelLoaded"), [], "explicit artifact ran the legacy worker");
	assert.equal(calls.length, transfers, "already verified selected artifact was transferred again");
	if (mode === "native") {
		const { page } = await import("../src/transfer/library.ts");
		const [row] = await page(null);
		assert.equal(row.raw, publicText);
		assert.equal(row.local, publicText);
		assert.match(ui.visible(), /\bbias\b[^\n]*\bapplied\b|\bapplied\b[^\n]*\bbias\b/i, "loaded bias rule disappeared because raw and local matched");
	}
}

async function advancedDeviceChoices(t) {
	const { isolatedJourney, assertUntouched, until } = await import("./transfer-journey-harness.mjs");
	const f = await isolatedJourney(t);
	await installManaged(t, streaming);
	await f.configure({ MICME_ARTIFACT: streaming.id, MICME_COMPUTE: device2.id, MICME_WHISPER_CPP_MODEL: "", MICME_TRANSCRIPTION_MODE: "stream" });
	engineState = { events: [], wrongBinding: true };
	const ui = await f.host({ width: 80 });
	const { pending } = await ui.open("conf");
	await ui.dialogs.pick(/advanced|experimental/i);
	await ui.dialogs.expect(/compute|device/i);
	await ui.dialogs.pick(/compute|device/i);
	await ui.dialogs.expect(/Fixture device A|fixture-vulkan-1/i);
	await ui.dialogs.expect(/Fixture device B|fixture-vulkan-2/i);
	await ui.dialogs.pick(/Fixture device B|fixture-vulkan-2/i);
	for (let n = 0; n < 8 && ui.dialogs.current; n++) ui.dialogs.input("\x1b");
	await pending;
	await ui.command();
	await until(() => /(?:device|binding|bound)[^\n]*(?:mismatch|different|did not|expected)|(?:mismatch|different)[^\n]*(?:device|binding)/i.test(ui.visible()), "same-family runtime binding mismatch was not diagnosed", ui.diagnostics);
	const loads = engineState.events.filter(({ kind }) => kind === "load");
	assert.equal(loads.length, 1, "explicit device fell back to another load");
	assert.equal(loads[0].choice.requestedDeviceId, device2.id);
	assert.deepEqual(loads[0].boundDevice, device1);
	assert.deepEqual(engineState.events.filter(({ kind }) => ["begin", "feed", "batch"].includes(kind)), []);
	assert.deepEqual(await f.events("clip"), []);
	assertUntouched(ui);
}

// Invoked as a child Node test run only; the aliases never contaminate the real
// Pi/legacy/library module graph or the source coverage identity of the main run.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	fixtureModules();
	test("loaded native stream uses exact PCM and reports a bias outcome without a text diff", async (t) => engineJourney(t, "native"));
	test("loaded batch route uses the full closed WAV and the explicit translation task", async (t) => engineJourney(t, "batch"));
	test("qualified advanced devices remain distinct and a loaded same-family mismatch refuses fallback", advancedDeviceChoices);
}
