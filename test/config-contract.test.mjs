import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
	NUMERIC_CONFIG_BOUNDS,
	getAutoDownloadModel,
	getAvfoundationInputSampleRate,
	getRecordSampleRate,
	getRecordSync,
	getLegacyStreamSettings,
	getShortcutSettingValue,
	getStreamFinalizeWithClip,
	getTerminalShortcut,
	getTranscribeBackend,
	getTranscribeSampleRate,
	getTranscribeTimeoutMs,
	getTranscriptionMode,
	getTranscriptionModeProfile,
	reloadMicmeConfig,
	writeMicmeConfigValues,
} = await import("../src/config.ts");
const { buildAudioPreprocessingArgs, buildRecorderCommand } = await import("../src/audio.ts");
const { buildLiveWorkerCommand } = await import("../src/streaming.ts");
const { resolveLivePlan } = await import("../src/live-plan.ts");

const INTEGER_SETTINGS = [
	{ key: "MICME_TRANSCRIBE_TIMEOUT_MS", getter: getTranscribeTimeoutMs, fallback: 120_000 },
	{ key: "MICME_RECORD_SAMPLE_RATE", getter: getRecordSampleRate, fallback: undefined },
	{ key: "MICME_TRANSCRIBE_SAMPLE_RATE", getter: getTranscribeSampleRate, fallback: 16_000 },
	{ key: "MICME_AVFOUNDATION_INPUT_SAMPLE_RATE", getter: getAvfoundationInputSampleRate, fallback: undefined },
];

const CONFIG_KEYS = [...INTEGER_SETTINGS.map((setting) => setting.key), "MICME_AUTO_DOWNLOAD_MODEL", "MICME_RECORD_SYNC", "MICME_STREAM_FINALIZE_WITH_CLIP"];
const LEGACY_KEYS = [
	"MICME_WHISPER_STREAM_BIN", "MICME_STREAM_CAPTURE", "MICME_STREAM_STEP_MS", "MICME_STREAM_LENGTH_MS", "MICME_STREAM_KEEP_MS",
	"MICME_STREAM_MAX_TOKENS", "MICME_STREAM_KEEP_CONTEXT", "MICME_STREAM_WORDS_PER_CHUNK", "MICME_STREAM_FLUSH_MS", "MICME_STREAM_VAD_THRESHOLD",
];

async function withEnvironment(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = String(value);
	}
	reloadMicmeConfig();
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		reloadMicmeConfig();
	}
}

async function readFromSource(root, source, key, value, getter) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousValue = process.env[key];
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		if (source === "environment") {
			await writeFile(join(root, "micme.json"), "{}\n");
			process.env[key] = String(value);
		} else {
			delete process.env[key];
			await writeFile(join(root, "micme.json"), `${JSON.stringify({ [key]: value }, null, 2)}\n`);
		}
		reloadMicmeConfig();
		return getter();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousValue === undefined) delete process.env[key];
		else process.env[key] = previousValue;
		reloadMicmeConfig();
	}
}

function getArgumentValue(args, flag) {
	const index = args.indexOf(flag);
	assert.notEqual(index, -1, `missing ${flag} in ${JSON.stringify(args)}`);
	return args[index + 1];
}

test("a host's recording shortcut default does not override explicit configuration", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-shortcut-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await withEnvironment({ PI_CODING_AGENT_DIR: root, MICME_SHORTCUT: undefined, MICME_PRINTABLE_SHORTCUTS: undefined }, async () => {
		assert.equal(getTerminalShortcut("alt+shift+m"), "alt+shift+m");
		assert.equal(getShortcutSettingValue("alt+shift+m"), "alt+shift+m");
		await writeFile(join(root, "micme.json"), '{"MICME_SHORTCUT":"f8"}');
		reloadMicmeConfig();
		assert.equal(getTerminalShortcut("alt+shift+m"), "f8");
		assert.equal(getShortcutSettingValue("alt+shift+m"), "f8");
	});
});

test("bounded integer settings share environment and JSON boundary behavior", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-config-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	for (const setting of INTEGER_SETTINGS) {
		const bounds = NUMERIC_CONFIG_BOUNDS[setting.key];
		for (const source of ["environment", "json"]) {
			assert.equal(await readFromSource(root, source, setting.key, bounds.minimum - 1, setting.getter), setting.fallback, `${source} ${setting.key} below minimum`);
			assert.equal(await readFromSource(root, source, setting.key, bounds.minimum, setting.getter), bounds.minimum, `${source} ${setting.key} at minimum`);
			assert.equal(await readFromSource(root, source, setting.key, bounds.maximum, setting.getter), bounds.maximum, `${source} ${setting.key} at maximum`);
			assert.equal(await readFromSource(root, source, setting.key, bounds.maximum + 1, setting.getter), setting.fallback, `${source} ${setting.key} above maximum`);
			assert.equal(await readFromSource(root, source, setting.key, "NaN", setting.getter), setting.fallback, `${source} ${setting.key} NaN`);
			assert.equal(await readFromSource(root, source, setting.key, "Infinity", setting.getter), setting.fallback, `${source} ${setting.key} infinity`);
		}
	}
});

test("flag and mode parsers use the same defaults for environment and JSON values", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-config-flags-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	for (const source of ["environment", "json"]) {
		assert.equal(await readFromSource(root, source, "MICME_AUTO_DOWNLOAD_MODEL", "off", getAutoDownloadModel), false);
		assert.equal(await readFromSource(root, source, "MICME_AUTO_DOWNLOAD_MODEL", "yes", getAutoDownloadModel), true);
		assert.equal(await readFromSource(root, source, "MICME_AUTO_DOWNLOAD_MODEL", "invalid", getAutoDownloadModel), true);
		assert.equal(await readFromSource(root, source, "MICME_RECORD_SYNC", "false", getRecordSync), false);
		assert.equal(await readFromSource(root, source, "MICME_RECORD_SYNC", "on", getRecordSync), true);
		assert.equal(await readFromSource(root, source, "MICME_RECORD_SYNC", "invalid", getRecordSync), true);
		assert.equal(await readFromSource(root, source, "MICME_TRANSCRIPTION_MODE", "stream", getTranscriptionMode), "stream");
		assert.equal(await readFromSource(root, source, "MICME_TRANSCRIPTION_MODE", "invalid", getTranscriptionMode), "clip");
		assert.equal(await readFromSource(root, source, "MICME_TRANSCRIBE_BACKEND", "python", getTranscribeBackend), "python");
		assert.equal(await readFromSource(root, source, "MICME_TRANSCRIBE_BACKEND", "invalid", getTranscribeBackend), "auto");
	}
});

test("fractional settings cannot produce invalid audio sample rates", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-config-fractions-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	for (const source of ["environment", "json"]) {
		assert.equal(await readFromSource(root, source, "MICME_RECORD_SAMPLE_RATE", 0.1, getRecordSampleRate), undefined);
		assert.equal(await readFromSource(root, source, "MICME_TRANSCRIBE_SAMPLE_RATE", 0.1, getTranscribeSampleRate), 16_000);
	}
});

test("schema, example, flags, and runtime defaults remain aligned", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-config-defaults-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "micme.json"), "{}\n");
	const unsetValues = Object.fromEntries(CONFIG_KEYS.map((key) => [key, undefined]));

	await withEnvironment({ PI_CODING_AGENT_DIR: root, ...unsetValues }, async () => {
		const schema = JSON.parse(await readFile(new URL("../micme.schema.json", import.meta.url), "utf8"));
		const example = JSON.parse(await readFile(new URL("../micme.example.json", import.meta.url), "utf8"));
		assert.equal(Object.hasOwn(schema.$defs.stringFlag, "default"), false);
		assert.equal(schema.properties.MICME_AUTO_DOWNLOAD_MODEL.default, "1");
		assert.equal(schema.properties.MICME_RECORD_SYNC.default, "1");
		assert.equal(example.MICME_AUTO_DOWNLOAD_MODEL, "1");
		assert.equal(example.MICME_RECORD_SYNC, "1");
		assert.equal(getAutoDownloadModel(), true);
		assert.equal(getRecordSync(), true);

		assert.equal(getStreamFinalizeWithClip(), false);
		assert.equal(schema.properties.MICME_STREAM_FINALIZE_WITH_CLIP.default, "0");
		assert.equal(example.MICME_STREAM_FINALIZE_WITH_CLIP, "0");
		for (const key of ["MICME_LIVE_BIN", "MICME_VAD_MODEL"]) {
			assert.equal(schema.properties[key].type, "string");
			assert.equal(example[key], "", "optional overrides in the example must not mask automatic resolution");
		}
		for (const key of LEGACY_KEYS) {
			const property = schema.properties[key];
			assert.equal(property.deprecated, true, key);
			assert.equal(Object.hasOwn(example, key), false, `${key} removed from example`);
		}

		for (const setting of INTEGER_SETTINGS) {
			const bounds = NUMERIC_CONFIG_BOUNDS[setting.key];
			const property = schema.properties[setting.key];
			assert.equal(property.minimum, bounds.minimum, `${setting.key} schema minimum`);
			assert.equal(property.maximum, bounds.maximum, `${setting.key} schema maximum`);
			if (property.default !== undefined) assert.equal(String(setting.getter() ?? "auto"), String(property.default), `${setting.key} runtime default`);
			if (example[setting.key] !== undefined && property.default !== undefined) assert.equal(String(example[setting.key]), String(property.default), `${setting.key} example default`);
		}

	});
});

test("mode profiles reset the final-pass flag but preserve shell precedence and other saved settings", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-config-mode-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "micme.json");
	const saved = { $schema: "./micme.schema.json", MICME_STREAM_FINALIZE_WITH_CLIP: "1", MICME_LIVE_BIN: "custom-worker", MICME_STREAM_CAPTURE: "4" };
	await writeFile(path, JSON.stringify(saved));
	await withEnvironment({ PI_CODING_AGENT_DIR: root, MICME_STREAM_FINALIZE_WITH_CLIP: "0" }, async () => {
		for (const [mode, finalize] of [["stream", "0"], ["clip", "1"]]) {
			const profile = getTranscriptionModeProfile(mode);
			assert.deepEqual(profile, { MICME_TRANSCRIPTION_MODE: mode, MICME_STREAM_FINALIZE_WITH_CLIP: finalize });
			await writeMicmeConfigValues(profile);
			const stored = JSON.parse(await readFile(path, "utf8"));
			assert.deepEqual(stored, { ...saved, ...profile });
			assert.equal(getStreamFinalizeWithClip(), false);
		}
	});
});

test("clip arguments use normalized rates while Worker v1 argv ignores old SDL tuning", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-config-args-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ffmpeg = join(root, "ffmpeg");
	await writeFile(ffmpeg, "#!/bin/sh\nexit 0\n");
	await chmod(ffmpeg, 0o755);
	await writeFile(join(root, "micme.json"), "{}\n");

	await withEnvironment(
		{
			PI_CODING_AGENT_DIR: root,
			PATH: `${root}:${process.env.PATH ?? ""}`,
			MICME_RECORD_SAMPLE_RATE: "0.1",
			MICME_TRANSCRIBE_SAMPLE_RATE: "0.1",
			MICME_TRANSCRIBE_BACKEND: "auto",
			MICME_LIVE_BIN: process.execPath,
			MICME_WHISPER_CPP_MODEL: join(root, "asr.bin"),
			MICME_VAD_MODEL: join(root, "vad.bin"),
			MICME_LANGUAGE: "de",
			MICME_TRANSLATE_TO_ENGLISH: "off",
			MICME_STREAM_CAPTURE: "999999",
			MICME_STREAM_STEP_MS: "0.1",
			MICME_STREAM_LENGTH_MS: "Infinity",
			MICME_STREAM_KEEP_MS: "-1",
			MICME_STREAM_MAX_TOKENS: "0",
			MICME_STREAM_VAD_THRESHOLD: "2",
		},
		async () => {
			const recorder = await buildRecorderCommand(join(root, "raw.wav"));
			assert.equal(recorder.args.includes("-ar"), false);
			const preprocess = buildAudioPreprocessingArgs(join(root, "raw.wav"), join(root, "clip.wav"), "");
			assert.equal(getArgumentValue(preprocess, "-ar"), "16000");
			const stream = buildLiveWorkerCommand(resolveLivePlan());
			assert.deepEqual(stream.args, ["--model", join(root, "asr.bin"), "--vad-model", join(root, "vad.bin"), "--language", "de"]);
			assert.ok(getLegacyStreamSettings().includes("MICME_STREAM_CAPTURE"));
		},
	);
});
