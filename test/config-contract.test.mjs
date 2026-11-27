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
	getStreamFinalizeWithClip,
	getTranscribeBackend,
	getTranscribeSampleRate,
	getTranscribeTimeoutMs,
	getTransferOptions,
	getTranscriptionMode,
	getTranscriptionModeProfile,
	reloadMicmeConfig,
	requireValidMicmeConfig,
	writeMicmeConfigValues,
} = await import("../src/config.ts");
const { TRANSFER_OPTION_DEFAULTS, POLISH_PROVIDERS } = await import("../src/transfer/contracts.ts");
const { decodeTransferOption, decodeTransferOptions, parseRetentionPolicy } = await import("../src/transfer/options.ts");
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
const UNSET_TRANSFER_OPTIONS = Object.fromEntries(Object.keys(TRANSFER_OPTION_DEFAULTS).map((key) => [key, undefined]));
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

test("transfer defaults stay inert and agree with the schema and example", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-transfer-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const schema = JSON.parse(await readFile(new URL("../micme.schema.json", import.meta.url), "utf8"));
	const example = JSON.parse(await readFile(new URL("../micme.example.json", import.meta.url), "utf8"));

	await withEnvironment({ PI_CODING_AGENT_DIR: root, ...UNSET_TRANSFER_OPTIONS }, async () => {
		const defaults = getTransferOptions();
		for (const [key, value] of Object.entries(TRANSFER_OPTION_DEFAULTS)) {
			assert.equal(schema.properties[key].default, value, key);
			assert.equal(example[key], value, key);
			assert.deepEqual(defaults[key], decodeTransferOption(key, value), key);
		}
		assert.deepEqual(schema.properties.MICME_POLISH_PROVIDER.enum, ["", ...POLISH_PROVIDERS]);
		assert.equal(defaults.MICME_ARTIFACT, null);
		assert.equal(defaults.MICME_HISTORY, false);
		assert.deepEqual(defaults.MICME_RETENTION, { kind: "never" });
		assert.equal(defaults.MICME_LOCAL_LID, false);
		assert.equal(defaults.MICME_REMOVE_FILLERS, false);
		assert.equal(defaults.MICME_SCRIPT, "as-spoken");
		assert.equal(defaults.MICME_POLISH_PROVIDER, null);
		assert.equal(defaults.MICME_POLISH_ENDPOINT, null);
		assert.equal(defaults.MICME_POLISH_KEY_ENV, null);
		assert.equal(defaults.MICME_OUTPUT_HOOK, null);
	});
});

test("transfer values round-trip through string config with exact literals and shell precedence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-transfer-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "micme.json");
	const unsetBackend = { MICME_TRANSCRIBE_BACKEND: undefined, MICME_TRANSCRIBE_COMMAND: undefined, MICME_WHISPER_CPP_MODEL: undefined };
	const saved = {
		MICME_ARTIFACT: "variant/quant-A",
		MICME_COMPUTE: "Adapter 4: GPU B",
		MICME_MODEL_IDLE: "5min",
		MICME_CHUNKING: "0",
		MICME_DETECTOR: "off",
		MICME_PREFERRED_LANGUAGES: '["PT-br"]',
		MICME_WORDS: '["$HOME","tool --flag"]',
		MICME_FILLERS: '["you know"]',
		MICME_LOCAL_LID: "1",
		MICME_REMOVE_FILLERS: "1",
		MICME_SCRIPT: "taiwan",
		MICME_HISTORY: "1",
		MICME_RETENTION: "count:0",
		MICME_POLISH_PROVIDER: "local-openai",
		MICME_POLISH_ENDPOINT: "http://127.0.0.1:8123/v1",
		MICME_POLISH_MODEL: "local-model",
		MICME_POLISH_PROMPT: "Preserve $HOME literally.\nKeep names.",
		MICME_POLISH_KEY_ENV: "MICME_TEST_KEY",
		MICME_OUTPUT_HOOK: "/opt/user tools/format final",
	};
	const fakeKey = "fixture-value-must-not-be-read-by-options";

	await withEnvironment({ PI_CODING_AGENT_DIR: root, ...UNSET_TRANSFER_OPTIONS, ...unsetBackend, MICME_TEST_KEY: fakeKey }, async () => {
		await writeMicmeConfigValues(saved);
		const { $schema, ...stored } = JSON.parse(await readFile(path, "utf8"));
		assert.equal(typeof $schema, "string");
		assert.deepEqual(stored, saved);
		const effective = getTransferOptions();
		assert.deepEqual(effective, decodeTransferOptions((key) => saved[key]));
		assert.equal(effective.MICME_COMPUTE, "Adapter 4: GPU B");
		assert.deepEqual(effective.MICME_PREFERRED_LANGUAGES, ["pt-BR"]);
		assert.deepEqual(effective.MICME_WORDS, ["$HOME", "tool --flag"]);
		assert.equal(effective.MICME_POLISH_KEY_ENV, "MICME_TEST_KEY");
		assert.ok(!JSON.stringify(effective).includes(fakeKey));

		await withEnvironment({ MICME_ARTIFACT: "", MICME_HISTORY: "0", MICME_WORDS: "[]" }, async () => {
			const overridden = getTransferOptions();
			assert.equal(overridden.MICME_ARTIFACT, null);
			assert.equal(overridden.MICME_HISTORY, false);
			assert.deepEqual(overridden.MICME_WORDS, []);
		});
		assert.equal(getTransferOptions().MICME_HISTORY, true);
	});
});

test("invalid enum and flag values are rejected rather than silently selecting a default", () => {
	assert.throws(() => decodeTransferOption("MICME_MODEL_IDLE", "later"), /MICME_MODEL_IDLE.*immediate.*5min.*never/);
	assert.throws(() => decodeTransferOption("MICME_HISTORY", "yes"), /MICME_HISTORY.*0 or 1/);
});

test("retention accepts zero and the maximum safe count, but rejects overflow and unsupported ages", () => {
	assert.deepEqual(parseRetentionPolicy("count:0"), { kind: "count", count: 0 });
	assert.deepEqual(parseRetentionPolicy(`count:${Number.MAX_SAFE_INTEGER}`), { kind: "count", count: Number.MAX_SAFE_INTEGER });
	assert.deepEqual(parseRetentionPolicy("days:14"), { kind: "days", days: 14 });
	for (const policy of ["count:-1", "count:1.5", "count:9007199254740992", "days:7"]) {
		assert.throws(() => parseRetentionPolicy(policy), /MICME_RETENTION.*nonnegative safe integer/);
	}
});

test("literal lists reject malformed JSON and non-string elements", () => {
	assert.throws(() => decodeTransferOption("MICME_WORDS", '["unterminated'), /MICME_WORDS.*JSON array/);
	assert.throws(() => decodeTransferOption("MICME_FILLERS", '["literal",1]'), /MICME_FILLERS.*nonblank strings/);
});

test("preferred languages reject format errors and the automatic selection sentinel", () => {
	for (const tags of ['["en_US"]', '["auto"]']) {
		assert.throws(() => decodeTransferOption("MICME_PREFERRED_LANGUAGES", tags), /MICME_PREFERRED_LANGUAGES.*BCP-47/);
	}
});

test("a polish endpoint is a credential-free HTTP(S) base URL", () => {
	assert.equal(decodeTransferOption("MICME_POLISH_ENDPOINT", "http://[::1]:8765/v1").href, "http://[::1]:8765/v1");
	for (const value of ["//localhost", "https:///localhost", "ftp://localhost", "https://user:fixture-value@localhost", "https://localhost/?auth=fixture-value", "https://localhost/#fragment"]) {
		assert.throws(() => decodeTransferOption("MICME_POLISH_ENDPOINT", value), /^TransferOptionError: MICME_POLISH_ENDPOINT must be an absolute HTTP\(S\) base URL without credentials, query, or fragment \(or an empty string\)$/);
	}
});

test("a polish key setting accepts an environment name, never an inline key", () => {
	assert.throws(() => decodeTransferOption("MICME_POLISH_KEY_ENV", "fixture-inline-value"), /^TransferOptionError: MICME_POLISH_KEY_ENV must be an environment variable name, not a credential value \(or an empty string\)$/);
});

test("output hook setting rejects a relative executable or shell expansion", () => {
	assert.throws(() => decodeTransferOption("MICME_OUTPUT_HOOK", "~/tools/my hook"), /MICME_OUTPUT_HOOK.*absolute path/);
});

test("artifact selection rejects conflicting explicit legacy backends or model paths", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-transfer-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const unsetBackend = { MICME_TRANSCRIBE_BACKEND: undefined, MICME_TRANSCRIBE_COMMAND: undefined, MICME_WHISPER_CPP_MODEL: undefined };
	await withEnvironment({ PI_CODING_AGENT_DIR: root, ...UNSET_TRANSFER_OPTIONS, ...unsetBackend, MICME_ARTIFACT: "variant" }, async () => {
		for (const values of [{ MICME_TRANSCRIBE_BACKEND: "python" }, { MICME_TRANSCRIBE_COMMAND: "custom-command" }, { MICME_WHISPER_CPP_MODEL: "/user-model" }]) {
			await withEnvironment(values, () => {
				assert.throws(requireValidMicmeConfig, new RegExp(`MICME_ARTIFACT.*${Object.keys(values)[0]}`));
			});
		}
	});
});

test("only an effective invalid transfer setting blocks work; a malformed saved type is not coerced", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-transfer-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "micme.json"), JSON.stringify({ MICME_HISTORY: 1, MICME_LANGUAGE: "fr" }));
	await withEnvironment({ PI_CODING_AGENT_DIR: root, ...UNSET_TRANSFER_OPTIONS }, async () => {
		assert.throws(getTransferOptions, /MICME_HISTORY.*a string/);
		await withEnvironment({ MICME_HISTORY: "0" }, () => {
			assert.equal(getTransferOptions().MICME_HISTORY, false);
			assert.equal(requireValidMicmeConfig().values.MICME_LANGUAGE, "fr");
		});
		await withEnvironment({ MICME_HISTORY: "invalid" }, () => {
			assert.throws(requireValidMicmeConfig, /MICME_HISTORY.*0 or 1/);
		});
	});
});

test("the atomic writer rejects malformed transfer values without replacing the file", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-transfer-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "micme.json");
	const original = '{"MICME_LANGUAGE":"fr","metadata":{"preserve":true}}\n';
	await writeFile(path, original);
	await withEnvironment({ PI_CODING_AGENT_DIR: root, ...UNSET_TRANSFER_OPTIONS, MICME_HISTORY: "0" }, async () => {
		await assert.rejects(writeMicmeConfigValues({ MICME_HISTORY: "bad", MICME_LANGUAGE: "de" }), /MICME_HISTORY.*0 or 1/);
		assert.equal(await readFile(path, "utf8"), original);
	});
});
