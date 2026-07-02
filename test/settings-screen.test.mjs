import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { reloadMicmeConfig, getTranscriptionModeProfile } = await import("../src/config.ts");
const { buildConfigurationItems, createModelSelector, showConfiguration, uniqueStrings } = await import("../src/settings.ts");
const { resolveTranscriptionPlan } = await import("../src/backends.ts");

const theme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

async function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
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

async function withTempAgent(t, fn) {
	const root = await mkdtemp(join(tmpdir(), "micme-settings-screen-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return withEnv({ PI_CODING_AGENT_DIR: root, MICME_MODEL_DIR: join(root, "models"), PATH: join(root, "bin") }, () => fn(root));
}

function createHarness(cwd = process.cwd()) {
	let component;
	let doneCount = 0;
	let renderRequests = 0;
	const notifications = [];
	const tui = {
		requestRender() {
			renderRequests += 1;
		},
	};
	const ctx = {
		mode: "tui",
		cwd,
		ui: {
			theme,
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus() {},
			custom(factory) {
				component = factory(tui, theme, {}, () => {
					doneCount += 1;
				});
			},
		},
	};
	return {
		ctx,
		notifications,
		get component() {
			return component;
		},
		get doneCount() {
			return doneCount;
		},
		get renderRequests() {
			return renderRequests;
		},
	};
}

function typeText(component, text) {
	for (const character of text) component.handleInput(character);
}

function waitForAsyncWork() {
	return new Promise((resolve) => setTimeout(resolve, 25));
}

test("showConfiguration warns outside interactive TUI mode", async () => {
	const notifications = [];
	const ctx = {
		mode: "cli",
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};

	await showConfiguration(ctx);

	assert.deepEqual(notifications, [{ message: "/micme conf requires interactive TUI mode.", level: "warning" }]);
});

test("configuration screen renders, searches, captures shortcuts, and saves values", async (t) => {
	await withTempAgent(t, async (root) => {
		await writeFile(join(root, "micme.json"), JSON.stringify({ MICME_AUTO_DOWNLOAD_MODEL: "1", MICME_PRINTABLE_SHORTCUTS: "§" }, null, 2));
		reloadMicmeConfig();
		const harness = createHarness(root);

		await showConfiguration(harness.ctx);
		await waitForAsyncWork();

		assert.ok(harness.component);
		assert.match(harness.component.render(100).join("\n"), /Micme Configuration/);
		assert.match(harness.component.render(44).join("\n"), /General|Auto-download/);
		assert.match(harness.component.render(14).join("\n"), /Micme Configuration|General/);

		harness.component.handleInput("\r");
		harness.component.handleInput(" ");
		await waitForAsyncWork();

		let saved = JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
		assert.equal(saved.MICME_AUTO_DOWNLOAD_MODEL, "0");

		harness.component.handleInput("/");
		typeText(harness.component, "Shortcut");
		assert.match(harness.component.render(90).join("\n"), /Shortcut/);

		harness.component.handleInput("\r");
		harness.component.handleInput("\r");
		assert.match(harness.component.render(90).join("\n"), /Press a shortcut before confirming/);
		harness.component.handleInput("~");
		assert.match(harness.component.render(90).join("\n"), /Captured ~/);
		harness.component.handleInput("\r");
		await waitForAsyncWork();

		saved = JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
		assert.equal(saved.MICME_SHORTCUT, "~");
		assert.equal(Object.hasOwn(saved, "MICME_PRINTABLE_SHORTCUTS"), false);
		assert.ok(harness.renderRequests > 0);

		harness.component.handleInput("\x1b");
		harness.component.handleInput("\x1b");
		assert.equal(harness.doneCount, 1);
	});
});

test("configuration screen reports invalid config safely", async (t) => {
	await withTempAgent(t, async (root) => {
		await writeFile(join(root, "micme.json"), "{ invalid json");
		reloadMicmeConfig();
		const harness = createHarness(root);

		await showConfiguration(harness.ctx);

		assert.equal(harness.notifications[0]?.level, "warning");
		assert.match(harness.notifications[0]?.message ?? "", /Micme config is invalid/);
	});
});

test("configuration items include discovered candidates and derived visibility", async (t) => {
	await withTempAgent(t, async (root) => {
		await writeFile(
			join(root, "micme.json"),
			JSON.stringify(
				{
					...getTranscriptionModeProfile("clip"),
					MICME_TRANSCRIBE_BACKEND: "python",
					MICME_WHISPER_MODEL: "small",
					MICME_AUDIO_DEVICE: "2",
					MICME_AUDIO_FILTER: "",
				},
				null,
				2,
			),
		);
		reloadMicmeConfig();

		const items = buildConfigurationItems(
			[{ label: "Tiny local", value: join(root, "models", "ggml-tiny.bin"), description: "local tiny", installed: true, kind: "path" }],
			[{ label: "Python small", value: "small", description: "python", installed: true, kind: "model-name" }],
			[{ label: "2: Studio Mic", value: "2", description: "USB mic" }],
			theme,
		);
		const ids = items.map((item) => item.id);
		const backend = items.find((item) => item.id === "MICME_TRANSCRIBE_BACKEND");
		const audio = items.find((item) => item.id === "MICME_AUDIO_DEVICE");
		const filter = items.find((item) => item.id === "MICME_AUDIO_FILTER");
		const cppModel = items.find((item) => item.id === "MICME_WHISPER_CPP_MODEL");
		const pythonModel = items.find((item) => item.id === "MICME_WHISPER_MODEL");
		const pythonPlan = resolveTranscriptionPlan({ requestedBackend: "python", pythonWhisperBinary: "whisper", whisperCppBinary: null });
		const cppPlan = resolveTranscriptionPlan({ requestedBackend: "whisper.cpp", whisperCppBinary: "whisper-cli", whisperCppModel: { path: join(root, "models", "ggml-tiny.bin"), exists: true, downloadable: true, source: "explicit-path", modelName: "tiny" } });

		assert.ok(ids.includes("MICME_STREAM_VAD_THRESHOLD"));
		assert.equal(backend?.rawValue, "python");
		assert.deepEqual(audio?.values, ["2"]);
		assert.equal(audio?.valueLabels?.["2"], "2: Studio Mic");
		assert.equal(filter?.currentValue, "<empty>");
		assert.equal(cppModel?.visibleWhen?.(pythonPlan), false);
		assert.equal(cppModel?.visibleWhen?.(cppPlan), true);
		assert.equal(pythonModel?.visibleWhen?.(pythonPlan), true);
		assert.equal(pythonModel?.visibleWhen?.(cppPlan), false);
		assert.deepEqual(uniqueStrings([" a ", "a", "", " ", "b"]), ["a", "", "b"]);
	});
});

test("model selector sanitizes labels and returns selected or cancelled values", () => {
	const selected = [];
	const selector = createModelSelector(
		[
			{ label: "\x1b[31mTiny\x1b[0m", value: "/models/ggml-tiny.bin", description: "\x1b]52;c;x\x07local", installed: true, kind: "path" },
			{ label: "Base", value: "/models/ggml-base.bin", description: "download", installed: false, kind: "model-name" },
		],
		theme,
		(value) => selected.push(value),
	);

	const rendered = selector.render(80).join("\n");
	assert.match(rendered, /Select whisper\.cpp model/);
	assert.equal(rendered.includes("\x1b"), false);

	selector.invalidate();
	selector.handleInput("\r");
	assert.deepEqual(selected, ["/models/ggml-tiny.bin"]);

	const cancelled = [];
	const cancelSelector = createModelSelector([], theme, (value) => cancelled.push(value));
	cancelSelector.handleInput("\x1b");
	assert.deepEqual(cancelled, [undefined]);
});
