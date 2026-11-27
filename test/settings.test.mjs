import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { reloadMicmeConfig } = await import("../src/config.ts");
const { createArtifactSelector, displayConfigurationValue, saveConfigurationValue } = await import("../src/settings.ts");
const { getManagedCatalogVariant, referenceRows } = await import("../src/transfer/catalog.ts");
const { getEngineEvidence } = await import("../src/transfer/engine-evidence.ts");

function createCtx() {
	return {
		ui: {
			setStatus() {},
			notify() {},
		},
	};
}

function detectorOffArtifacts() {
	return referenceRows().flatMap(({ variants }) => variants.flatMap(({ id }) => {
		const evidence = getEngineEvidence(id);
		const cell = evidence?.measurements.find(({ disposition, language, task }) => disposition === "adapted-verified" && language === "en" && task === "transcribe");
		if (evidence?.traits?.vad !== "off" || evidence.traits.actualCompute !== "cpu" || !cell) return [];
		const variant = getManagedCatalogVariant(id, { rig: cell.rig, actualCompute: "cpu", device: cell.device }, cell.task, cell.language);
		return variant ? [variant] : [];
	}));
}

async function withArtifactConfig(t, { shellDetector, savedDetector, language = "en", compute, shellArtifact } = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "micme-artifact-settings-"));
	const configPath = join(agentDir, "micme.json");
	const initial = { MICME_LANGUAGE: language, MICME_TRANSCRIBE_BACKEND: "auto", ...(savedDetector ? { MICME_DETECTOR: savedDetector } : {}), ...(compute ? { MICME_COMPUTE: compute } : {}) };
	const scoped = { PI_CODING_AGENT_DIR: agentDir, MICME_DETECTOR: shellDetector, MICME_LANGUAGE: undefined, MICME_TRANSLATE_TO_ENGLISH: undefined,
		MICME_ARTIFACT: shellArtifact, MICME_COMPUTE: undefined, MICME_TRANSCRIBE_BACKEND: undefined, MICME_WHISPER_CPP_MODEL: undefined, MICME_TRANSCRIBE_COMMAND: undefined };
	const previous = Object.fromEntries(Object.keys(scoped).map((key) => [key, process.env[key]]));
	t.after(async () => {
		for (const [key, value] of Object.entries(previous)) setEnvValue(key, value);
		reloadMicmeConfig();
		await rm(agentDir, { recursive: true, force: true });
	});
	for (const [key, value] of Object.entries(scoped)) setEnvValue(key, value);
	await writeFile(configPath, JSON.stringify(initial));
	reloadMicmeConfig();
	return { configPath, initial };
}

function setEnvValue(key, value) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

const plainTheme = { fg: (_color, text) => text, bold: (text) => text };

test("the artifact picker requires an explicit compatible detector choice and saves the pair together", async (t) => {
	const { configPath, initial } = await withArtifactConfig(t);
	const artifacts = detectorOffArtifacts();
	assert.equal(artifacts.length, 2);
	const picked = [];
	const picker = createArtifactSelector(artifacts, "", "model", plainTheme, (...choice) => picked.push(choice));
	picker.handleInput("\x1b[B");
	picker.handleInput("\r");
	assert.match(picker.render(40).join("\n"), /→ Cancel/);
	assert.match(picker.render(40).join("\n"), /Use with detector Off/);
	picker.handleInput("\r");
	assert.deepEqual(picked, []);
	assert.equal(JSON.parse(await readFile(configPath, "utf8")).MICME_ARTIFACT, undefined);
	picker.handleInput("\r");
	picker.handleInput("\x1b[B");
	picker.handleInput("\r");
	assert.deepEqual(picked, [[artifacts[0].id, "off"]]);
	await assert.rejects(saveConfigurationValue(createCtx(), "MICME_ARTIFACT", artifacts[0].id), /requires.*detector Off/i);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), initial);
	await saveConfigurationValue(createCtx(), "MICME_ARTIFACT", picked[0][0], { artifactDetector: picked[0][1] });
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { ...initial, MICME_ARTIFACT: artifacts[0].id, MICME_DETECTOR: "off" });
});

test("an incompatible shell detector blocks artifact selection without changing either saved choice", async (t) => {
	const { configPath, initial } = await withArtifactConfig(t, { shellDetector: "model", savedDetector: "off" });
	const artifacts = detectorOffArtifacts();
	const picked = [];
	const picker = createArtifactSelector(artifacts, "", "model", plainTheme, (...choice) => picked.push(choice));
	picker.handleInput("\x1b[B");
	picker.handleInput("\r");
	const screen = picker.render(80).join("\n");
	assert.match(screen, /Shell override MICME_DETECTOR/);
	assert.doesNotMatch(screen, /Use with detector Off/);
	assert.deepEqual(picked, []);
	await assert.rejects(saveConfigurationValue(createCtx(), "MICME_ARTIFACT", artifacts[0].id, { artifactDetector: "off" }), /Shell override MICME_DETECTOR/);
	assert.equal(process.env.MICME_DETECTOR, "model");
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), initial);
});

test("Auto language accepts an artifact with a qualified transcription language without changing the preference", async (t) => {
	const { configPath, initial } = await withArtifactConfig(t, { language: "auto", savedDetector: "off" });
	const [artifact] = detectorOffArtifacts();
	await saveConfigurationValue(createCtx(), "MICME_ARTIFACT", artifact.id);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { ...initial, MICME_ARTIFACT: artifact.id });
});

test("artifact selection cannot replace an incompatible requested compute with a qualified backend", async (t) => {
	const { configPath, initial } = await withArtifactConfig(t, { compute: "vulkan", savedDetector: "off" });
	const [artifact] = detectorOffArtifacts();
	await assert.rejects(saveConfigurationValue(createCtx(), "MICME_ARTIFACT", artifact.id), /requested compute/i);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), initial);
});

test("a shell artifact override prevents an ineffective selection from changing the saved detector", async (t) => {
	const [artifact] = detectorOffArtifacts();
	const { configPath, initial } = await withArtifactConfig(t, { shellArtifact: artifact.id });
	await assert.rejects(saveConfigurationValue(createCtx(), "MICME_ARTIFACT", artifact.id, { artifactDetector: "off" }), /Shell override MICME_ARTIFACT/);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), initial);
});

test("configuration display values strip terminal control sequences", () => {
	assert.equal(displayConfigurationValue("MICME_LANGUAGE", "en\x1b]52;c;clipboard\x07\x1b[31m-US\x1b[0m"), "en -US");
	assert.equal(displayConfigurationValue("MICME_WHISPER_CPP_MODEL", "/tmp/\x1b[31mggml-small.en.bin\x1b[0m"), "ggml-small.en.bin");
});

test("changing the mode resets the final-pass default without changing local capture and model choices", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "micme-settings-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		reloadMicmeConfig();
		await rm(agentDir, { recursive: true, force: true });
	});
	const configPath = join(agentDir, "micme.json");
	const initial = {
		MICME_TRANSCRIPTION_MODE: "clip",
		MICME_WHISPER_CPP_MODEL: "/offline/Base ASR.bin",
		MICME_LIVE_BIN: "/offline/Live worker",
		MICME_VAD_MODEL: "/offline/Silero weights.bin",
		MICME_PULSE_SOURCE: "studio.monitor",
		MICME_STREAM_FINALIZE_WITH_CLIP: "1",
		MICME_STREAM_DIAGNOSTICS: "1",
		MICME_STREAM_VAD_THRESHOLD: "0.6",
		MICME_RECORD_SAMPLE_RATE: "48000",
		MICME_AUDIO_FILTER: "",
	};
	await writeFile(configPath, JSON.stringify(initial));
	reloadMicmeConfig();

	const ctx = createCtx();
	await saveConfigurationValue(ctx, "MICME_TRANSCRIPTION_MODE", "stream");
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { ...initial, MICME_TRANSCRIPTION_MODE: "stream", MICME_STREAM_FINALIZE_WITH_CLIP: "0" });

	await saveConfigurationValue(ctx, "MICME_STREAM_FINALIZE_WITH_CLIP", "1");
	await saveConfigurationValue(ctx, "MICME_STREAM_DIAGNOSTICS", "0");
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { ...initial, MICME_TRANSCRIPTION_MODE: "stream", MICME_STREAM_DIAGNOSTICS: "0" });

	await saveConfigurationValue(ctx, "MICME_STREAM_FINALIZE_WITH_CLIP", "0");
	await saveConfigurationValue(ctx, "MICME_TRANSCRIPTION_MODE", "clip");
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { ...initial, MICME_STREAM_DIAGNOSTICS: "0" });
});

test("saving a missing model rechecks config and rejects malformed JSON before fetching", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "micme-settings-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousAutoDownload = process.env.MICME_AUTO_DOWNLOAD_MODEL;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousAutoDownload === undefined) delete process.env.MICME_AUTO_DOWNLOAD_MODEL;
		else process.env.MICME_AUTO_DOWNLOAD_MODEL = previousAutoDownload;
		reloadMicmeConfig();
		await rm(agentDir, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.MICME_AUTO_DOWNLOAD_MODEL = "1";
	const configPath = join(agentDir, "micme.json");
	await writeFile(configPath, "{}");
	reloadMicmeConfig();
	const malformed = "{ invalid json";
	await writeFile(configPath, malformed);
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response("mock model bytes"));

	const save = saveConfigurationValue(createCtx(), "MICME_WHISPER_CPP_MODEL", join(agentDir, "models", "ggml-tiny.bin"));
	await assert.rejects(save, (error) => error.message.includes(configPath) && /invalid.*JSON|not valid JSON/.test(error.message));
	assert.equal(fetch.mock.callCount(), 0);
	assert.equal(await readFile(configPath, "utf8"), malformed);
});

test("clearing the whisper.cpp model removes the explicit override from micme.json", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "micme-settings-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		reloadMicmeConfig();
		await rm(agentDir, { recursive: true, force: true });
	});

	process.env.PI_CODING_AGENT_DIR = agentDir;
	const configPath = join(agentDir, "micme.json");
	await writeFile(configPath, JSON.stringify({ MICME_WHISPER_CPP_MODEL: "/tmp/ggml-small.en.bin", MICME_LANGUAGE: "en" }, null, 2));
	reloadMicmeConfig();

	await saveConfigurationValue(createCtx(), "MICME_WHISPER_CPP_MODEL", "");

	const saved = JSON.parse(await readFile(configPath, "utf8"));
	assert.equal(Object.hasOwn(saved, "MICME_WHISPER_CPP_MODEL"), false);
	assert.equal(saved.MICME_LANGUAGE, "en");
});
