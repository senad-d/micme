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
	getStreamCapture,
	getStreamFlushMs,
	getStreamKeepMs,
	getStreamLengthMs,
	getStreamMaxTokens,
	getStreamStepMs,
	getStreamVadThreshold,
	getStreamWordsPerChunk,
	getTranscribeBackend,
	getTranscribeSampleRate,
	getTranscribeTimeoutMs,
	getTranscriptionMode,
	reloadMicmeConfig,
} = await import("../src/config.ts");
const { buildAudioPreprocessingArgs, buildRecorderCommand } = await import("../src/audio.ts");
const { buildWhisperStreamCommand } = await import("../src/streaming.ts");
const { buildConfigurationItems } = await import("../src/settings.ts");

const theme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

const INTEGER_SETTINGS = [
	{ key: "MICME_TRANSCRIBE_TIMEOUT_MS", getter: getTranscribeTimeoutMs, fallback: 120_000 },
	{ key: "MICME_STREAM_CAPTURE", getter: getStreamCapture, fallback: -1 },
	{ key: "MICME_STREAM_STEP_MS", getter: getStreamStepMs, fallback: 1_000 },
	{ key: "MICME_STREAM_LENGTH_MS", getter: getStreamLengthMs, fallback: 5_000 },
	{ key: "MICME_STREAM_KEEP_MS", getter: getStreamKeepMs, fallback: 500 },
	{ key: "MICME_STREAM_MAX_TOKENS", getter: getStreamMaxTokens, fallback: 64 },
	{ key: "MICME_STREAM_FLUSH_MS", getter: getStreamFlushMs, fallback: 700 },
	{ key: "MICME_STREAM_WORDS_PER_CHUNK", getter: getStreamWordsPerChunk, fallback: 10 },
	{ key: "MICME_RECORD_SAMPLE_RATE", getter: getRecordSampleRate, fallback: undefined },
	{ key: "MICME_TRANSCRIBE_SAMPLE_RATE", getter: getTranscribeSampleRate, fallback: 16_000 },
	{ key: "MICME_AVFOUNDATION_INPUT_SAMPLE_RATE", getter: getAvfoundationInputSampleRate, fallback: undefined },
];

const CONFIG_KEYS = [...INTEGER_SETTINGS.map((setting) => setting.key), "MICME_STREAM_VAD_THRESHOLD", "MICME_AUTO_DOWNLOAD_MODEL", "MICME_RECORD_SYNC"];

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

test("normalized fractions and VAD bounds cannot produce invalid sink values", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-config-fractions-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	for (const source of ["environment", "json"]) {
		assert.equal(await readFromSource(root, source, "MICME_STREAM_STEP_MS", 0.1, getStreamStepMs), 1_000);
		assert.equal(await readFromSource(root, source, "MICME_STREAM_FLUSH_MS", 0.1, getStreamFlushMs), 700);
		assert.equal(await readFromSource(root, source, "MICME_STREAM_WORDS_PER_CHUNK", 0.1, getStreamWordsPerChunk), 10);
		assert.equal(await readFromSource(root, source, "MICME_RECORD_SAMPLE_RATE", 0.1, getRecordSampleRate), undefined);
		assert.equal(await readFromSource(root, source, "MICME_TRANSCRIBE_SAMPLE_RATE", 0.1, getTranscribeSampleRate), 16_000);
		assert.equal(await readFromSource(root, source, "MICME_STREAM_WORDS_PER_CHUNK", 0.6, getStreamWordsPerChunk), 1);
		assert.equal(await readFromSource(root, source, "MICME_STREAM_VAD_THRESHOLD", 0, getStreamVadThreshold), 0.45);
		assert.equal(await readFromSource(root, source, "MICME_STREAM_VAD_THRESHOLD", 0.01, getStreamVadThreshold), 0.01);
		assert.equal(await readFromSource(root, source, "MICME_STREAM_VAD_THRESHOLD", 0.99, getStreamVadThreshold), 0.99);
		assert.equal(await readFromSource(root, source, "MICME_STREAM_VAD_THRESHOLD", 1, getStreamVadThreshold), 0.45);
		assert.equal(await readFromSource(root, source, "MICME_STREAM_VAD_THRESHOLD", "Infinity", getStreamVadThreshold), 0.45);
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

		const items = buildConfigurationItems([], [], [], theme);
		const uiValues = Object.fromEntries(items.map((item) => [item.id, item.currentValue]));
		assert.equal(uiValues.MICME_AUTO_DOWNLOAD_MODEL, "1");
		assert.equal(uiValues.MICME_RECORD_SYNC, "1");
		assert.equal(uiValues.MICME_STREAM_CAPTURE, "-1");
		assert.equal(uiValues.MICME_STREAM_FLUSH_MS, "700");
		assert.equal(uiValues.MICME_STREAM_WORDS_PER_CHUNK, "10");
		assert.equal(uiValues.MICME_STREAM_VAD_THRESHOLD, "0.45");
		assert.equal(uiValues.MICME_RECORD_SAMPLE_RATE, "auto");
		assert.equal(uiValues.MICME_TRANSCRIBE_SAMPLE_RATE, "16000");

		for (const setting of INTEGER_SETTINGS) {
			const bounds = NUMERIC_CONFIG_BOUNDS[setting.key];
			const property = schema.properties[setting.key];
			assert.equal(property.minimum, bounds.minimum, `${setting.key} schema minimum`);
			assert.equal(property.maximum, bounds.maximum, `${setting.key} schema maximum`);
			if (property.default !== undefined) assert.equal(String(setting.getter() ?? "auto"), String(property.default), `${setting.key} runtime default`);
			if (example[setting.key] !== undefined && property.default !== undefined) assert.equal(String(example[setting.key]), String(property.default), `${setting.key} example default`);
		}

		assert.equal(schema.properties.MICME_STREAM_VAD_THRESHOLD.minimum, NUMERIC_CONFIG_BOUNDS.MICME_STREAM_VAD_THRESHOLD.minimum);
		assert.equal(schema.properties.MICME_STREAM_VAD_THRESHOLD.maximum, NUMERIC_CONFIG_BOUNDS.MICME_STREAM_VAD_THRESHOLD.maximum);
		assert.equal(String(getStreamVadThreshold()), schema.properties.MICME_STREAM_VAD_THRESHOLD.default);
		assert.equal(example.MICME_STREAM_VAD_THRESHOLD, schema.properties.MICME_STREAM_VAD_THRESHOLD.default);
	});
});

test("normalized values are the only values emitted in recorder, preprocessing, and stream arguments", async (t) => {
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
			MICME_STREAM_CAPTURE: "999999",
			MICME_STREAM_STEP_MS: "0.1",
			MICME_STREAM_LENGTH_MS: "Infinity",
			MICME_STREAM_KEEP_MS: "-1",
			MICME_STREAM_MAX_TOKENS: "0",
			MICME_STREAM_VAD_THRESHOLD: "2",
		},
		async () => {
			const recorder = buildRecorderCommand(join(root, "raw.wav"));
			assert.equal(recorder.args.includes("-ar"), false);
			const preprocess = buildAudioPreprocessingArgs(join(root, "raw.wav"), join(root, "clip.wav"), "");
			assert.equal(getArgumentValue(preprocess, "-ar"), "16000");
			const stream = buildWhisperStreamCommand("whisper-stream", join(root, "model.bin"), root);
			assert.equal(getArgumentValue(stream.args, "--capture"), "-1");
			assert.equal(getArgumentValue(stream.args, "--step"), "1000");
			assert.equal(getArgumentValue(stream.args, "--length"), "5000");
			assert.equal(getArgumentValue(stream.args, "--keep"), "500");
			assert.equal(getArgumentValue(stream.args, "--max-tokens"), "64");
			assert.equal(getArgumentValue(stream.args, "--vad-thold"), "0.45");
		},
	);
});
