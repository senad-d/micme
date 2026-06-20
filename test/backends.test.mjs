import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { resolveTranscriptionPlan } = await import("../src/backends.ts");
const { getPrintableShortcuts, getShortcutSettingValue, getTerminalShortcut, getTranscribeBackend, getTranslateToEnglishLanguage } = await import("../src/config.ts");
const { getPythonWhisperModelName, resolveWhisperCppModel } = await import("../src/models.ts");

const fakeWhisperCppModel = {
	path: "/models/ggml-small.en.bin",
	modelName: "small.en",
	source: "default-name",
	exists: false,
	downloadable: true,
};

function resolveWith(overrides) {
	return resolveTranscriptionPlan({
		transcriptionMode: "clip",
		whisperCppModel: fakeWhisperCppModel,
		...overrides,
	});
}

function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("auto resolves custom, then whisper.cpp, then Python, then none", () => {
	assert.equal(resolveWith({ requestedBackend: "auto", customCommand: "echo ok", whisperCppBinary: "/bin/whisper-cli", pythonWhisperBinary: "/bin/whisper" }).effectiveBackend, "custom");
	assert.equal(resolveWith({ requestedBackend: "auto", customCommand: null, whisperCppBinary: "/bin/whisper-cli", pythonWhisperBinary: "/bin/whisper" }).effectiveBackend, "whisper.cpp");
	assert.equal(resolveWith({ requestedBackend: "auto", customCommand: null, whisperCppBinary: null, pythonWhisperBinary: "/bin/whisper" }).effectiveBackend, "python");
	assert.equal(resolveWith({ requestedBackend: "auto", customCommand: null, whisperCppBinary: null, pythonWhisperBinary: null }).effectiveBackend, "none");
});

test("explicit Python does not silently fall back to whisper.cpp", () => {
	const plan = resolveWith({ requestedBackend: "python", whisperCppBinary: "/bin/whisper-cli", pythonWhisperBinary: null });
	assert.equal(plan.effectiveBackend, "none");
	assert.match(plan.reason, /python/i);
});

test("explicit whisper.cpp does not silently fall back to Python", () => {
	const plan = resolveWith({ requestedBackend: "whisper.cpp", whisperCppBinary: null, pythonWhisperBinary: "/bin/whisper" });
	assert.equal(plan.effectiveBackend, "none");
	assert.match(plan.reason, /whisper\.cpp/i);
});

test("explicit custom requires MICME_TRANSCRIBE_COMMAND", () => {
	const missing = resolveWith({ requestedBackend: "custom", customCommand: null, whisperCppBinary: "/bin/whisper-cli", pythonWhisperBinary: "/bin/whisper" });
	assert.equal(missing.effectiveBackend, "none");
	assert.match(missing.reason, /MICME_TRANSCRIBE_COMMAND/);

	const configured = resolveWith({ requestedBackend: "custom", customCommand: "cat {audio}", whisperCppBinary: null, pythonWhisperBinary: null });
	assert.equal(configured.effectiveBackend, "custom");
});

test("getTranscribeBackend reads valid values and falls back to auto", () => {
	withEnv({ MICME_TRANSCRIBE_BACKEND: "python" }, () => {
		assert.equal(getTranscribeBackend(), "python");
	});
	withEnv({ MICME_TRANSCRIBE_BACKEND: "bogus" }, () => {
		assert.equal(getTranscribeBackend(), "auto");
	});
	withEnv({ MICME_TRANSCRIBE_BACKEND: "" }, () => {
		assert.equal(getTranscribeBackend(), "auto");
	});
});

test("translation to English is a single off-or-language option", () => {
	withEnv({ MICME_TRANSLATE_TO_ENGLISH: "off" }, () => {
		assert.equal(getTranslateToEnglishLanguage(), undefined);
	});
	withEnv({ MICME_TRANSLATE_TO_ENGLISH: "bs" }, () => {
		assert.equal(getTranslateToEnglishLanguage(), "bs");
	});
});

test("translation uses translate-capable Whisper model names", () => {
	withEnv(
		{
			MICME_TRANSLATE_TO_ENGLISH: "bs",
			MICME_WHISPER_CPP_MODEL: "",
			MICME_MODEL_DIR: join(tmpdir(), "micme-model-test"),
			MICME_DEFAULT_WHISPER_CPP_MODEL: "small.en",
			MICME_WHISPER_MODEL: "base.en",
		},
		() => {
			const model = resolveWhisperCppModel();
			assert.equal(model.path, join(tmpdir(), "micme-model-test", "ggml-small.bin"));
			assert.equal(model.modelName, "small");
			assert.equal(getPythonWhisperModelName(), "base");
		},
	);

	withEnv(
		{
			MICME_TRANSLATE_TO_ENGLISH: "hr",
			MICME_WHISPER_CPP_MODEL: "",
			MICME_MODEL_DIR: join(tmpdir(), "micme-model-test"),
			MICME_DEFAULT_WHISPER_CPP_MODEL: "large-v3-turbo",
			MICME_WHISPER_MODEL: "large-v3-turbo",
		},
		() => {
			const model = resolveWhisperCppModel();
			assert.equal(model.path, join(tmpdir(), "micme-model-test", "ggml-large-v3.bin"));
			assert.equal(model.modelName, "large-v3");
			assert.equal(model.translationFallbackFrom, "large-v3-turbo");
			assert.equal(getPythonWhisperModelName(), "large-v3");
		},
	);
});

test("translation remaps explicit whisper.cpp turbo paths to the nearest translate-capable sibling", () => {
	withEnv(
		{
			MICME_TRANSLATE_TO_ENGLISH: "hr",
			MICME_WHISPER_CPP_MODEL: "/models/ggml-large-v3-turbo.bin",
		},
		() => {
			const model = resolveWhisperCppModel();
			assert.equal(model.path, "/models/ggml-large-v3.bin");
			assert.equal(model.modelName, "large-v3");
			assert.equal(model.translationFallbackFrom, "large-v3-turbo");
			assert.equal(model.downloadable, true);
		},
	);
});

test("unified shortcut can be a printable editor fallback", () => {
	withEnv({ MICME_SHORTCUT: "§", MICME_PRINTABLE_SHORTCUTS: "" }, () => {
		assert.equal(getShortcutSettingValue(), "§");
		assert.equal(getTerminalShortcut(), undefined);
		assert.deepEqual(getPrintableShortcuts(), ["§"]);
	});
});

test("unified shortcut can be a terminal shortcut", () => {
	withEnv({ MICME_SHORTCUT: "ctrl+space", MICME_PRINTABLE_SHORTCUTS: "" }, () => {
		assert.equal(getShortcutSettingValue(), "ctrl+space");
		assert.equal(getTerminalShortcut(), "ctrl+space");
		assert.deepEqual(getPrintableShortcuts(), []);
	});
});

test("legacy printable shortcut still works alongside a terminal shortcut", () => {
	withEnv({ MICME_SHORTCUT: "alt+m", MICME_PRINTABLE_SHORTCUTS: "µ" }, () => {
		assert.equal(getShortcutSettingValue(), "alt+m");
		assert.equal(getTerminalShortcut(), "alt+m");
		assert.deepEqual(getPrintableShortcuts(), ["µ"]);
	});
});

test("invalid requested backend falls back to auto without throwing", () => {
	const plan = resolveWith({ requestedBackend: "bogus", customCommand: null, whisperCppBinary: null, pythonWhisperBinary: "/bin/whisper" });
	assert.equal(plan.requestedBackend, "auto");
	assert.equal(plan.effectiveBackend, "python");
});

test("whisper.cpp model name maps through MICME_MODEL_DIR", () => {
	withEnv(
		{
			MICME_TRANSLATE_TO_ENGLISH: "off",
			MICME_WHISPER_CPP_MODEL: "",
			MICME_MODEL_DIR: join(tmpdir(), "micme-model-test"),
			MICME_DEFAULT_WHISPER_CPP_MODEL: "small.en",
		},
		() => {
			const model = resolveWhisperCppModel();
			assert.equal(model.path, join(tmpdir(), "micme-model-test", "ggml-small.en.bin"));
			assert.equal(model.modelName, "small.en");
			assert.equal(model.source, "configured-name");
		},
	);
});

test("explicit whisper.cpp model path overrides model name", () => {
	withEnv(
		{
			MICME_TRANSLATE_TO_ENGLISH: "off",
			MICME_WHISPER_CPP_MODEL: "/custom/model.bin",
			MICME_MODEL_DIR: join(tmpdir(), "micme-model-test"),
			MICME_DEFAULT_WHISPER_CPP_MODEL: "medium.en",
		},
		() => {
			const model = resolveWhisperCppModel();
			assert.equal(model.path, "/custom/model.bin");
			assert.equal(model.source, "explicit-path");
		},
	);
});

test("stream mode rejects Python and custom backends", () => {
	const python = resolveTranscriptionPlan({ requestedBackend: "python", transcriptionMode: "stream", pythonWhisperBinary: "/bin/whisper", whisperStreamBinary: "/bin/whisper-stream", whisperCppModel: fakeWhisperCppModel });
	assert.equal(python.effectiveBackend, "none");
	assert.match(python.reason, /Streaming mode requires whisper\.cpp/);

	const custom = resolveTranscriptionPlan({ requestedBackend: "custom", transcriptionMode: "stream", customCommand: "echo ok", whisperStreamBinary: "/bin/whisper-stream", whisperCppModel: fakeWhisperCppModel });
	assert.equal(custom.effectiveBackend, "none");
	assert.match(custom.reason, /Streaming mode requires whisper\.cpp/);
});
