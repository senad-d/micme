import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { WHISPER_CPP_MODEL_NAMES, WHISPER_VAD_MODEL } from "../../src/constants.ts";
import { wordErrors } from "./scoring.mjs";

const snapshot = new URL("./transfer-catalog-source.json", import.meta.url);
const managedRepo = "ggerganov/whisper.cpp";
const sha = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const atom = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const repo = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const evidence = "test/live-native/transfer-catalog-source.json";

function digest(input) {
	return createHash("sha256").update(input).digest("hex");
}

// Reimplemented from the tagged Rust rule, not its recommendations or picker rank.
export function isTaggedOffer(model) {
	return model.role === "asr" && Object.hasOwn(model.files, model.quant) && !model.files[model.quant].filename.includes("/");
}

function checkFile({ filename, size, sha256 }) {
	assert(typeof filename === "string" && filename.split("/").every((part) => atom.test(part)), "Invalid model filename");
	assert(Number.isSafeInteger(size) && size > 0 && sha.test(sha256), `Missing exact LFS identity for ${filename}`);
}

function selectModels({ schema, models }) {
	assert.equal(schema, 2, "Unsupported Handy catalog schema");
	assert(Array.isArray(models), "Missing model inventory");
	const seen = new Set();
	for (const { id, role, curated, capabilities, quant, repository, revision, files } of models) {
		assert(typeof id === "string" && atom.test(id), "Invalid catalog ID");
		assert(!seen.has(id), `Duplicate catalog ID ${id}`);
		seen.add(id);
		assert(["asr", "langid", "vad", "diarize"].includes(role), `Invalid role for ${id}`);
		assert(typeof curated === "boolean" && typeof capabilities.streaming === "boolean" && typeof capabilities.translate === "boolean", `Missing catalog claims for ${id}`);
		assert(repo.test(repository) && commit.test(revision) && atom.test(quant), `Unpinned reference ${id}`);
		const paths = new Set();
		for (const [key, file] of Object.entries(files)) {
			assert(atom.test(key), `Invalid quant for ${id}`);
			checkFile(file);
			assert(!paths.has(file.filename), `Duplicate variant file ${id}/${file.filename}`);
			paths.add(file.filename);
		}
	}
	return models.filter(isTaggedOffer);
}

// Use only factual fields. Do not copy names/descriptions, scores, results, or mirrors.
export function projectTaggedCatalog({ schema, models }) {
	return { schema, models: models.map(({ id, role, curated, license, capabilities, quant, repository, revision, files }) => ({
		id, role, curated, license, capabilities: { streaming: capabilities.streaming, translate: capabilities.translate }, quant, repository, revision,
		files: Object.fromEntries(Object.entries(files).map(([key, { filename, size, sha256 }]) => [key, { filename, size, sha256 }])),
	})) };
}

function variantId(id, quant, repository, revision, file) {
	// Changes to any exact source identity must get a different evidence lookup key.
	const key = digest(JSON.stringify([repository, revision, file.filename, file.size, file.sha256]));
	return `${id}/${quant ?? "model"}@${key}`;
}

function blob(repository, revision, file) {
	checkFile(file);
	assert(repo.test(repository) && commit.test(revision), "Unpinned download source");
	return { url: `https://huggingface.co/${repository}/resolve/${revision}/${file.filename}`, revision, path: file.filename, bytes: file.size, sha256: file.sha256 };
}

function checkProvenance({ baseRevision, conversion, terms, attribution }) {
	assert(commit.test(baseRevision) || sha.test(baseRevision), "Missing exact base revision");
	assert([conversion, terms, attribution].every((value) => typeof value === "string" && value.trim()), "Missing conversion, terms or attribution");
}

function pinnedVariant(fields, pinned, reason) {
	checkProvenance(fields);
	return { ...fields, blobs: [pinned], rights: "cleared", runtime: "untested", languages: [], traits: null, measurements: [], reason };
}

function candidate(model, quant, file, reviewed) {
	const checked = reviewed?.files[quant];
	if (!checked) return null;
	assert.equal(reviewed.repository, model.repository, `Wrong candidate repository for ${model.id}`);
	assert.equal(reviewed.revision, model.revision, `Wrong candidate revision for ${model.id}`);
	assert.deepEqual(checked, file, `LFS pin differs from the tag: ${model.id}/${quant}`);
	const { baseRevision, conversion, terms, attribution } = reviewed;
	const id = variantId(model.id, quant, model.repository, model.revision, file);
	return {
		...pinnedVariant({ id, quant, baseRevision, conversion, terms, attribution }, blob(model.repository, model.revision, checked), "Exact export audited for offline qualification; Micme native load and task evidence are still needed."),
		runtime: "needs-adapter",
	};
}

function heldDisposition(model) {
	if (model.license === "cc-by-nc-4.0" || model.license === "cc-by-nc-sa-4.0") {
		return { rights: "restricted", reason: "Noncommercial terms in the tagged source; no general-purpose Micme download offer." };
	}
	if (model.license === "cc-by-sa-4.0") return { rights: "unresolved", reason: "ShareAlike terms: audit exact export, changes and notice obligations before offering it." };
	return { rights: "unresolved", reason: "Needs exact base/tokenizer/export rights and independent LFS verification before native qualification." };
}

function compileReference(model, review, hold) {
	const { id, curated, capabilities, quant: defaultQuant, repository, revision, license } = model;
	const variants = [];
	const pins = [];
	for (const [quant, file] of Object.entries(model.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
		const pinned = candidate(model, quant, file, review);
		variants.push({ id: variantId(id, quant, repository, revision, file), quant, path: file.filename });
		if (pinned) pins.push(pinned);
	}
	return { claim: { id, curated, ...capabilities, defaultQuant, repository, revision, license, variants, ...(hold ?? heldDisposition(model)) }, pins };
}

function smokeCell(smoke, observation, pinned) {
	if (!observation) return null;
	assert.equal(observation.sha256, pinned.sha256, `Smoke observation is for another artifact: ${pinned.path}`);
	assert.equal(observation.code, 0, `Failed smoke observation for ${pinned.path}`);
	const { wer } = wordErrors(smoke.reference, observation.raw);
	assert(wer !== null && wer <= 0.2, `Smoke recognition differs from the public reference: ${pinned.path}`);
	return { feature: "M2", language: "en", task: "transcribe", rig: smoke.rig, device: null, wer, cer: null, xrt: null, evidence, disposition: "existing-verified" };
}

function compileWhisper({ repository, revision, terms, attribution, conversion, models, smoke }) {
	assert.equal(repository, managedRepo, "Wrong standard Whisper source");
	assert.deepEqual(Object.keys(models).sort(), [...WHISPER_CPP_MODEL_NAMES].sort(), "Whisper pins must match WHISPER_CPP_MODEL_NAMES");
	assert(commit.test(smoke.engineRevision) && sha.test(smoke.binarySha256) && sha.test(smoke.wavSha256) && smoke.rig.trim(), "Missing exact clip smoke identity");
	const observations = new Map(smoke.observations.map((item) => [item.name, item]));
	assert.equal(observations.size, smoke.observations.length, "Duplicate clip smoke observations");
	assert([...observations.keys()].every((name) => Object.hasOwn(models, name) || name === "silero"), "Unknown clip smoke model");
	return WHISPER_CPP_MODEL_NAMES.map((name) => {
		const { size, sha256, checkpoint, tokenizer, publication } = models[name];
		const file = { filename: `ggml-${name}.bin`, size, sha256 };
		const pinned = blob(managedRepo, revision, file);
		assert(commit.test(publication) && typeof tokenizer === "string" && tokenizer.trim(), `Missing source history for ${name}`);
		const id = variantId(`whisper.cpp/${name}`, "F16", managedRepo, revision, file);
		const fields = { id, quant: "F16", baseRevision: checkpoint, conversion: `${conversion} Export publication: https://huggingface.co/${managedRepo}/commit/${publication}. Vocabulary: ${tokenizer}`, terms, attribution };
		const row = pinnedVariant(fields, pinned, "Needs an observed English CPU clip result for this exact export.");
		const cell = smokeCell(smoke, observations.get(name), pinned);
		if (cell) Object.assign(row, { runtime: "passed", languages: [cell.language], measurements: [cell], reason: null });
		return { name, row };
	});
}

function compileVad({ repository, revision, file, baseRevision, conversion, terms, attribution }, { smoke, models }) {
	const pinned = blob(repository, revision, file);
	assert.deepEqual(pinned, { url: WHISPER_VAD_MODEL.url, path: WHISPER_VAD_MODEL.file, revision, ...WHISPER_VAD_MODEL.integrity }, "Silero ledger pin differs from existing managed VAD");
	const id = variantId("whisper.cpp/silero-vad-v5.1.2", null, repository, revision, file);
	const row = pinnedVariant({ id, quant: null, baseRevision, conversion, terms, attribution }, pinned, "Ancillary detector; not an ASR offer.");
	const observation = smoke.observations.find(({ name }) => name === "silero");
	if (observation) {
		assert.equal(observation.asrSha256, models["small.en"].sha256, "VAD clip observation used a different ASR artifact");
		assert(Number.isSafeInteger(observation.speechSegments) && observation.speechSegments > 0, "No observed VAD segments");
		smokeCell(smoke, observation, pinned);
		row.runtime = "passed";
	}
	return row;
}

function renderArray(name, type, rows) {
	return `export const ${name}: readonly ${type}[] = [\n${rows.map((row) => `\t${JSON.stringify(row)},\n`).join("")}];\n`;
}

export function renderCatalog(source) {
	assert.equal(source.version, 1, "Unsupported transfer catalog snapshot");
	const offered = selectModels(source.tagged);
	assert.deepEqual([
		offered.length,
		offered.filter((row) => row.curated).length,
		offered.filter((row) => row.capabilities.translate).length,
		offered.filter((row) => row.capabilities.streaming).length,
	], [73, 29, 16, 8], "Tagged inventory does not reconcile");
	const known = new Map(offered.map((model) => [model.id, model]));
	for (const [id, review] of Object.entries(source.reviewed)) {
		assert(known.has(id), `Review for unknown reference model ${id}`);
		assert(Object.keys(review.files).every((quant) => Object.hasOwn(known.get(id).files, quant)), `Review for unknown quant of ${id}`);
	}
	for (const id of Object.keys(source.holds)) assert(known.has(id) && !Object.hasOwn(source.reviewed, id), `Invalid hold for ${id}`);
	const rows = offered.map((model) => compileReference(model,
		Object.hasOwn(source.reviewed, model.id) ? source.reviewed[model.id] : undefined,
		Object.hasOwn(source.holds, model.id) ? source.holds[model.id] : undefined));
	const excluded = source.tagged.models.filter((model) => !isTaggedOffer(model)).map(({ id, role, repository, revision }) => ({ id, role, repository, revision }));
	const whisper = compileWhisper(source.whisper);
	const vad = compileVad(source.vad, source.whisper);
	return [
		"// Generated by test/live-native/transfer-catalog.mjs. Do not edit.\n",
		"import type { AuxiliaryReference, ReferenceClaim, StandardWhisper } from \"./catalog.ts\";\n",
		"import type { Variant } from \"./contracts.ts\";\n\n",
		renderArray("TAGGED_ROWS", "ReferenceClaim", rows.map(({ claim }) => claim)),
		renderArray("AUXILIARY_ROWS", "AuxiliaryReference", excluded),
		renderArray("REVIEWED_EXPORTS", "Variant", rows.flatMap(({ pins }) => pins)),
		renderArray("STANDARD_WHISPER", "StandardWhisper", whisper),
		`export const STANDARD_VAD: Variant = ${JSON.stringify(vad)};\n`,
	].join("");
}

// The B dispatcher accepts either transfer-catalog-source.json (offline) or the
// original catalog.json at the pinned Handy commit. Only the checked-in snapshot
// can supply permissions, LFS receipts, and smoke evidence in either mode.
export async function buildCatalog(sourcePath, destination) {
	const [bytes, trusted] = await Promise.all([readFile(sourcePath), readFile(snapshot, "utf8")]);
	const input = JSON.parse(bytes);
	const source = JSON.parse(trusted);
	if (input.schema !== undefined) {
		assert.equal(digest(bytes), source.reference.catalogSha256, "Not the pinned Handy v0.10.2 catalog");
		assert.deepEqual(projectTaggedCatalog(input), source.tagged, "Offline projection differs from the tagged source");
	} else {
		assert.deepEqual(input, source, "Not the checked-in offline catalog snapshot");
	}
	await writeFile(destination, renderCatalog(source));
}
