import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WHISPER_CPP_MODEL_NAMES, WHISPER_VAD_MODEL } from "../src/constants.ts";
import {
	applyCatalogEvidence, auxiliaryReferences, getCatalogVariant, getManagedCatalogVariant, getManagedWhisperVariant,
	getWhisperVariant, referenceClaim, referenceRows, whisperVadVariant, whisperVariants,
} from "../src/transfer/catalog.ts";
import { buildCatalog, isTaggedOffer, projectTaggedCatalog, renderCatalog } from "./live-native/transfer-catalog.mjs";

const sourcePath = new URL("./live-native/transfer-catalog-source.json", import.meta.url);
const outputPath = new URL("../src/transfer/catalog-data.ts", import.meta.url);
const source = JSON.parse(await readFile(sourcePath, "utf8"));

const rig = { rig: "exact rig", actualCompute: "vulkan", device: { id: "gpu-a", label: "same model" } };
const traits = { stream: true, batch: false, longForm: false, nativeLid: false, bias: false, translateEn: false, languages: ["en"], vad: "off", actualCompute: rig.actualCompute, boundDevice: rig.device };
const cell = { feature: "M4", language: "en", task: "transcribe", rig: rig.rig, device: rig.device, wer: 0.1, cer: null, xrt: null, evidence: "trace.jsonl:4", disposition: "adapted-verified" };

function candidate() {
	const claim = referenceClaim("moonshine-streaming-tiny");
	return getCatalogVariant(claim.variants.find(({ quant }) => quant === claim.defaultQuant).id);
}

function passEvidence(variant) {
	return (id) => id === variant.id ? { runtime: "passed", traits, measurements: [cell] } : null;
}

async function cleanup(dir) {
	await rm(dir, { recursive: true, force: true });
}

test("offline catalog regeneration is byte-identical to the checked-in source", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "micme-catalog-"));
	t.after(cleanup.bind(null, dir));
	const output = join(dir, "catalog-data.ts");
	await buildCatalog(sourcePath, output);
	assert.deepEqual(await readFile(output), await readFile(outputPath));
});

test("untagged upstream input cannot replace an output", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "micme-catalog-"));
	t.after(cleanup.bind(null, dir));
	const input = join(dir, "catalog.json");
	const output = join(dir, "catalog-data.ts");
	await writeFile(input, JSON.stringify(source.tagged));
	await writeFile(output, "existing\n");
	await assert.rejects(buildCatalog(input, output), /Not the pinned Handy/);
	assert.equal(await readFile(output, "utf8"), "existing\n");
});

test("edited offline metadata cannot authorize regeneration", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "micme-catalog-"));
	t.after(cleanup.bind(null, dir));
	const changed = structuredClone(source);
	changed.whisper.smoke.rig = "another rig";
	const input = join(dir, "source.json");
	await writeFile(input, JSON.stringify(changed));
	await assert.rejects(buildCatalog(input, join(dir, "catalog-data.ts")), /Not the checked-in offline catalog snapshot/);
});

test("tagged offer predicate needs ASR with a root-level designated default, regardless of curation", () => {
	const asr = source.tagged.models.find((model) => model.role === "asr" && !model.curated);
	assert.equal(isTaggedOffer(asr), true);
	for (const role of ["vad", "langid", "diarize"]) assert.equal(isTaggedOffer({ ...asr, role }), false);
	assert.equal(isTaggedOffer({ ...asr, quant: "absent" }), false);
	assert.equal(isTaggedOffer({ ...asr, files: { ...asr.files, [asr.quant]: { filename: "sub/model.gguf" } } }), false);
});

test("the ASR inventory reconciles every source ID and quant without auxiliary or legacy rows", () => {
	const rows = referenceRows();
	const expected = source.tagged.models.filter(isTaggedOffer);
	assert.deepEqual(rows.map(({ id }) => id), expected.map(({ id }) => id));
	assert.deepEqual(rows.map(({ variants }) => variants.map(({ quant }) => quant).sort()), expected.map(({ files }) => Object.keys(files).sort()));
	assert.deepEqual([rows.length, rows.filter(({ curated }) => curated).length,
		rows.filter(({ id }) => referenceClaim(id).translate).length, rows.filter(({ id }) => referenceClaim(id).streaming).length], [73, 29, 16, 8]);
	assert.equal(new Set(rows.flatMap(({ variants }) => variants.map(({ id }) => id))).size, 385);
	assert.deepEqual(auxiliaryReferences().map(({ role }) => role).sort(), ["diarize", "langid", "vad"]);
	assert.equal(getCatalogVariant("/home/user/custom/model.gguf"), null);
	assert.equal(getWhisperVariant("my-custom-model"), null);
});

test("projected source retains factual identities, not benchmarks, presentation or mirrors", () => {
	const tagged = structuredClone(source.tagged);
	const model = tagged.models[0];
	const quant = model.quant;
	tagged.results = { [model.id]: "external benchmark" };
	model.description = "editorial copy";
	model.files[quant].mirror = "https://example.invalid";
	assert.deepEqual(projectTaggedCatalog(tagged), source.tagged);
});

test("duplicate source IDs are rejected even in the excluded set", () => {
	const copy = structuredClone(source);
	copy.tagged.models.push(copy.tagged.models.find(({ role }) => role === "vad"));
	assert.throws(() => renderCatalog(copy), /Duplicate catalog ID/);
});

test("duplicate physical files cannot appear as two quant variants of the same model", () => {
	const copy = structuredClone(source);
	const model = copy.tagged.models[0];
	model.files["fake-quant"] = model.files[model.quant];
	assert.throws(() => renderCatalog(copy), /Duplicate variant file/);
});

test("conflicting LFS evidence cannot produce a reviewed artifact", () => {
	const copy = structuredClone(source);
	copy.reviewed["moonshine-streaming-tiny"].files.Q8_0.sha256 = "5".repeat(64);
	assert.throws(() => renderCatalog(copy), /LFS pin differs from the tag/);
});

test("an artifact key changes if its source identity changes", () => {
	const copy = structuredClone(source);
	const model = copy.tagged.models.find(({ id }) => id === "whisper-tiny");
	const { id } = referenceClaim(model.id).variants.find(({ quant }) => quant === model.quant);
	model.files[model.quant].sha256 = "5".repeat(64);
	assert(!renderCatalog(copy).includes(id));
});

test("tagged terms and capabilities do not grant managed download offers", () => {
	const rows = referenceRows();
	for (const { variants } of rows) {
		for (const variant of variants) {
			assert(variant.reason);
			assert.equal(variant.traits, null);
			assert.equal(getManagedCatalogVariant(variant.id, rig, "transcribe", "en"), null);
		}
	}
	const unified = rows.find(({ id }) => id === "parakeet-unified-en-0.6b");
	assert(unified.variants.every(({ rights, blobs, reason }) => rights === "unresolved" && !blobs.length && /conflict/i.test(reason)));
	assert.equal(candidate().rights, "cleared");
	assert.equal(candidate().runtime, "needs-adapter");
});

test("exact native evidence is loaded only for the qualified rig and bound device", () => {
	const variant = candidate();
	assert.equal(applyCatalogEvidence(variant, passEvidence(variant), rig).runtime, "passed");
	assert.equal(applyCatalogEvidence(variant, passEvidence(variant), { ...rig, rig: "another rig" }).traits, null);
	assert.equal(applyCatalogEvidence(variant, passEvidence(variant), { ...rig, device: { ...rig.device, id: "gpu-b" } }).traits, null);
	assert.deepEqual(applyCatalogEvidence(variant, passEvidence(variant), { ...rig, actualCompute: "metal" }).measurements, []);
	assert.equal(applyCatalogEvidence(variant, passEvidence(variant)).runtime, "needs-adapter");
	assert.equal(applyCatalogEvidence({ ...variant, id: "different export" }, passEvidence(variant), rig).traits, null);
});

test("passed flags cannot promote restricted rights, ambiguous traits or unverified tasks", () => {
	const variant = candidate();
	const passed = passEvidence(variant)(variant.id);
	const blocked = { ...variant, rights: "unresolved" };
	assert.deepEqual(applyCatalogEvidence(blocked, passEvidence(variant), rig), blocked);
	assert.equal(applyCatalogEvidence(variant, () => ({ ...passed, measurements: [cell, { ...cell, rig: "another rig" }] }), rig).traits, null);
	assert.equal(applyCatalogEvidence(variant, () => ({ ...passed, measurements: [{ ...cell, disposition: "unverified" }] }), rig).traits, null);
	assert.equal(applyCatalogEvidence(variant, () => ({ ...passed, measurements: [{ ...cell, task: "translate-en" }] }), rig).traits, null);
});

test("managed standard rows require immutable bytes, notices and positive exact task evidence", () => {
	assert.deepEqual(whisperVariants().map(({ name }) => name), WHISPER_CPP_MODEL_NAMES);
	for (const { name, row } of whisperVariants()) {
		const [blob] = row.blobs;
		assert.equal(blob.url, `https://huggingface.co/ggerganov/whisper.cpp/resolve/${source.whisper.revision}/ggml-${name}.bin`);
		assert.equal(blob.sha256, source.whisper.models[name].sha256);
		assert.equal(blob.bytes, source.whisper.models[name].size);
		assert(row.baseRevision && row.conversion && row.terms && row.attribution);
		const smoke = source.whisper.smoke.observations.some((observation) => observation.name === name);
		assert.deepEqual(getManagedWhisperVariant(name), smoke ? row : null);
		if (smoke) assert(row.measurements.some(({ language, task, rig: key }) => language === "en" && task === "transcribe" && key === source.whisper.smoke.rig));
	}
	assert(getManagedWhisperVariant("small.en"));
	assert.deepEqual(whisperVadVariant().blobs[0], { url: WHISPER_VAD_MODEL.url, path: WHISPER_VAD_MODEL.file, revision: source.vad.revision, ...WHISPER_VAD_MODEL.integrity });
	assert.equal(whisperVadVariant().runtime, "passed");
	assert.equal(getCatalogVariant(whisperVadVariant().id), null);
});

test("Whisper CPU clip observations do not qualify a scoped lookup on another rig", () => {
	const { id, measurements } = getManagedWhisperVariant("small.en");
	assert.equal(getCatalogVariant(id, { rig: measurements[0].rig, actualCompute: "cpu", device: null }).runtime, "passed");
	assert.equal(getCatalogVariant(id, rig).runtime, "untested");
	assert.deepEqual(getCatalogVariant(id, rig).measurements, []);
});

test("a smoke result for a different payload cannot authorize a managed offer", () => {
	const copy = structuredClone(source);
	copy.whisper.smoke.observations.find(({ name }) => name === "small.en").sha256 = "5".repeat(64);
	assert.throws(() => renderCatalog(copy), /Smoke observation is for another artifact/);
});

test("editing a returned catalog row cannot mutate later evidence or pins", () => {
	const row = candidate();
	row.blobs[0].url = "https://example.invalid";
	row.rights = "unresolved";
	assert.notEqual(candidate().blobs[0].url, row.blobs[0].url);
	assert.equal(candidate().rights, "cleared");
});
