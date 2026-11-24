import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { reloadMicmeConfig } from "../src/config.ts";
import { ensureLiveModels, resolveLivePlan } from "../src/live-plan.ts";

const executableExtension = process.platform === "win32" ? ".EXE" : "";

async function setupLiveConfig(t, config = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme-live-plan-"));
	const modelDir = join(root, "models");
	const values = {
		PI_CODING_AGENT_DIR: root,
		PATH: relative(process.cwd(), root),
		PATHEXT: ".EXE",
		MICME_AUTO_DOWNLOAD_MODEL: undefined,
		MICME_DEFAULT_WHISPER_CPP_MODEL: undefined,
		MICME_LANGUAGE: undefined,
		MICME_LIVE_BIN: undefined,
		MICME_MODEL_DIR: undefined,
		MICME_STREAM_FINALIZE_WITH_CLIP: undefined,
		MICME_TRANSCRIBE_BACKEND: undefined,
		MICME_TRANSCRIBE_COMMAND: undefined,
		MICME_TRANSLATE_TO_ENGLISH: undefined,
		MICME_VAD_MODEL: undefined,
		MICME_WHISPER_CPP_MODEL: undefined,
		MICME_WHISPER_STREAM_BIN: undefined,
	};
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	t.after(async () => {
		setEnv(previous);
		await rm(root, { recursive: true, force: true });
	});
	await writeFile(join(root, "micme.json"), JSON.stringify({ MICME_MODEL_DIR: modelDir, ...config }));
	setEnv(values);
	return { root, modelDir };
}

function setEnv(values) {
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	reloadMicmeConfig();
}

async function writeExecutable(root, name) {
	const path = join(root, name + executableExtension);
	// Intentionally not runnable: resolution cannot require launching a child or probing model readiness.
	await writeFile(path, "executable discovery fixture", { mode: 0o755 });
	return path;
}

test("live resolution selects micme-live over SDL without downloading or writing", async (t) => {
	const { root, modelDir } = await setupLiveConfig(t);
	const binary = await writeExecutable(root, "micme-live");
	await writeExecutable(root, "whisper-stream");
	t.mock.method(globalThis, "fetch", () => assert.fail("resolution must not fetch weights"));
	const before = await readdir(root);
	const plan = resolveLivePlan();
	assert.deepEqual(plan, {
		binary,
		modelPath: join(modelDir, "ggml-small.en.bin"),
		vadModelPath: join(modelDir, "vad", "ggml-silero-v5.1.2.bin"),
		language: "en",
		translate: false,
		finalizeWithClip: false,
	});
	setEnv({ MICME_MODEL_DIR: modelDir });
	assert.deepEqual(resolveLivePlan(), plan);
	assert.deepEqual(await readdir(root), before);
});

test("live resolution expands JSON paths, then takes explicit environment overrides", async (t) => {
	const { root } = await setupLiveConfig(t, {
		MICME_LIVE_BIN: `$PI_CODING_AGENT_DIR/json worker${executableExtension}`,
		MICME_WHISPER_CPP_MODEL: "$PI_CODING_AGENT_DIR/ggml-small.bin",
		MICME_VAD_MODEL: "$PI_CODING_AGENT_DIR/json VAD.bin",
		MICME_LANGUAGE: "bs",
		MICME_STREAM_FINALIZE_WITH_CLIP: true,
	});
	const binary = await writeExecutable(root, "json worker");
	assert.deepEqual(resolveLivePlan(), {
		binary,
		modelPath: join(root, "ggml-small.bin"),
		vadModelPath: join(root, "json VAD.bin"),
		language: "bs",
		translate: false,
		finalizeWithClip: true,
	});

	const envBinary = await writeExecutable(root, "env-worker");
	setEnv({
		MICME_LIVE_BIN: "env-worker",
		MICME_WHISPER_CPP_MODEL: relative(process.cwd(), join(root, "ggml-medium.bin")),
		MICME_VAD_MODEL: relative(process.cwd(), join(root, "env VAD.bin")),
		MICME_LANGUAGE: " DE ",
		MICME_STREAM_FINALIZE_WITH_CLIP: "0",
	});
	assert.deepEqual(resolveLivePlan(), {
		binary: envBinary,
		modelPath: join(root, "ggml-medium.bin"),
		vadModelPath: join(root, "env VAD.bin"),
		language: "de",
		translate: false,
		finalizeWithClip: false,
	});
});

test("live resolution tells users of unsupported backends how to select worker streaming or clip", async (t) => {
	await setupLiveConfig(t);
	for (const backend of ["python", "custom", "unknown"]) {
		setEnv({ MICME_TRANSCRIBE_BACKEND: backend });
		assert.throws(resolveLivePlan, /MICME_TRANSCRIBE_BACKEND.*(?:auto|whisper\.cpp).*clip/i);
	}
});

test("the SDL executable is never a live worker default or an accepted explicit override", async (t) => {
	const { root } = await setupLiveConfig(t);
	const legacy = await writeExecutable(root, "whisper-stream");
	assert.throws(resolveLivePlan, /micme-live.*not found.*MICME_LIVE_BIN/i);
	setEnv({ MICME_LIVE_BIN: legacy });
	assert.throws(resolveLivePlan, /whisper-stream.*MICME_LIVE_BIN/i);
	if (process.platform !== "win32") {
		await symlink(legacy, join(root, "micme-live"));
		setEnv({ MICME_LIVE_BIN: undefined });
		assert.throws(resolveLivePlan, /whisper-stream.*MICME_LIVE_BIN/i);
	}
});

test("an invalid explicit live executable reports its setting rather than falling back to PATH", async (t) => {
	const { root } = await setupLiveConfig(t);
	await writeExecutable(root, "micme-live");
	setEnv({ MICME_LIVE_BIN: join(root, "missing-worker") });
	assert.throws(resolveLivePlan, /MICME_LIVE_BIN.*not found.*missing-worker/i);
});

test("auto becomes English only with known English-only weights, including quantized filenames", async (t) => {
	const { root } = await setupLiveConfig(t);
	await writeExecutable(root, "micme-live");
	setEnv({ MICME_LANGUAGE: "AUTO", MICME_WHISPER_CPP_MODEL: join(root, "ggml-base.en-q5_1.bin") });
	assert.equal(resolveLivePlan().language, "en");
	setEnv({ MICME_WHISPER_CPP_MODEL: join(root, "ggml-base-q5_1.bin") });
	assert.equal(resolveLivePlan().language, "auto");
});

test("a non-English language is incompatible with known English-only live weights", async (t) => {
	const { root } = await setupLiveConfig(t);
	await writeExecutable(root, "micme-live");
	setEnv({ MICME_LANGUAGE: "de", MICME_WHISPER_CPP_MODEL: join(root, "ggml-base.en-q5_1.bin") });
	assert.throws(resolveLivePlan, /base\.en-q5_1.*English-only.*MICME_LANGUAGE.*multilingual/i);
});

test("translation takes the source language and maps named weights to translate-capable choices", async (t) => {
	const { root, modelDir } = await setupLiveConfig(t);
	const binary = await writeExecutable(root, "micme-live");
	setEnv({ MICME_TRANSCRIBE_BACKEND: "whisper.cpp", MICME_LANGUAGE: "en", MICME_TRANSLATE_TO_ENGLISH: "HR" });
	assert.deepEqual(resolveLivePlan(), {
		binary,
		modelPath: join(modelDir, "ggml-small.bin"),
		vadModelPath: join(modelDir, "vad", "ggml-silero-v5.1.2.bin"),
		language: "hr",
		translate: true,
		finalizeWithClip: false,
	});
	setEnv({ MICME_DEFAULT_WHISPER_CPP_MODEL: "large-v3-turbo" });
	assert.equal(resolveLivePlan().modelPath, join(modelDir, "ggml-large-v3.bin"));
});

test("translation rejects known incompatible explicit paths instead of replacing them", async (t) => {
	const { root } = await setupLiveConfig(t);
	await writeExecutable(root, "micme-live");
	setEnv({ MICME_TRANSLATE_TO_ENGLISH: "hr" });
	for (const name of ["ggml-base.en.bin", "ggml-large-v3-turbo-q5_0.bin"]) {
		const model = join(root, name);
		setEnv({ MICME_WHISPER_CPP_MODEL: model });
		assert.throws(resolveLivePlan, { message: /does not support translation.*MICME_WHISPER_CPP_MODEL.*multilingual/i });
	}
});

test("explicit ensure provisions the resolved ASR and uses the resolved local VAD without a VAD fetch", async (t) => {
	const { root } = await setupLiveConfig(t, { MICME_AUTO_DOWNLOAD_MODEL: true, MICME_VAD_MODEL: "$PI_CODING_AGENT_DIR/custom-vad.bin" });
	await writeExecutable(root, "micme-live");
	const plan = resolveLivePlan();
	const fetch = t.mock.method(globalThis, "fetch", async (url) => {
		assert.match(url, /\/ggml-small\.en\.bin$/);
		return new Response("ASR fixture");
	});
	const ctx = { ui: { setStatus() {}, notify() {} } };
	const signal = new AbortController().signal;
	await assert.rejects(ensureLiveModels(plan, ctx, signal), /VAD model is missing.*MICME_VAD_MODEL/i);
	assert.equal(fetch.mock.callCount(), 0);
	await writeFile(plan.vadModelPath, "local VAD");
	await ensureLiveModels(plan, ctx, signal);
	await ensureLiveModels(plan, ctx, signal);
	assert.equal(fetch.mock.callCount(), 1);
	assert.equal(await readFile(plan.modelPath, "utf8"), "ASR fixture");
	assert.equal(await readFile(plan.vadModelPath, "utf8"), "local VAD");
});
