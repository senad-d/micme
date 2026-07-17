import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function withMockFetch(fetchImpl, fn) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
}

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
	const statusCalls = [];
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
			setStatus(key, value) {
				statusCalls.push({ key, value });
			},
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
		statusCalls,
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
		await waitFor(async () => {
			const config = JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
			return config.MICME_AUTO_DOWNLOAD_MODEL === "0";
		}, "auto-download setting was not saved");

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
		await waitFor(async () => {
			const config = JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
			return config.MICME_SHORTCUT === "~" && !Object.hasOwn(config, "MICME_PRINTABLE_SHORTCUTS");
		}, "shortcut setting was not saved");

		saved = JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
		assert.equal(saved.MICME_SHORTCUT, "~");
		assert.equal(Object.hasOwn(saved, "MICME_PRINTABLE_SHORTCUTS"), false);
		assert.ok(harness.renderRequests > 0);

		harness.component.handleInput("\x1b");
		harness.component.handleInput("\x1b");
		assert.equal(harness.doneCount, 1);
	});
});

test("closing configuration during model acquisition cancels without stale saves or UI work", async (t) => {
	await withTempAgent(t, async (root) => {
		await writeFile(join(root, "micme.json"), JSON.stringify({ MICME_AUTO_DOWNLOAD_MODEL: "1" }, null, 2));
		reloadMicmeConfig();
		const harness = createHarness(root);
		const response = createDeferred();
		let fetchSignal;

		await withMockFetch(
			async (_url, options) => {
				fetchSignal = options.signal;
				return response.promise;
			},
			async () => {
				await showConfiguration(harness.ctx);
				await waitFor(() => !harness.component.render(100).join("\n").includes("Loading "), "configuration discovery did not finish");
				harness.component.handleInput("/");
				typeText(harness.component, "Whisper.cpp model");
				assert.match(harness.component.render(100).join("\n"), /Whisper\.cpp model/i);
				harness.component.handleInput("\r");
				assert.match(harness.component.render(100).join("\n"), /Select whisper\.cpp model/i);
				harness.component.handleInput("\x1b[A");
				assert.match(harness.component.render(100).join("\n"), /tiny/i);
				harness.component.handleInput("\r");
				await waitFor(() => fetchSignal !== undefined, "model fetch did not start");

				harness.component.handleInput("q");
				const rendersAfterClose = harness.renderRequests;
				const notificationsAfterClose = harness.notifications.length;
				await waitFor(() => fetchSignal.aborted, "model fetch was not aborted when configuration closed");
				await waitForAsyncWork();

				assert.equal(harness.doneCount, 1);
				assert.equal(harness.renderRequests, rendersAfterClose);
				assert.equal(harness.notifications.length, notificationsAfterClose);
			},
		);

		const saved = JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
		assert.deepEqual(saved, { MICME_AUTO_DOWNLOAD_MODEL: "1" });
		assert.deepEqual(await readdir(join(root, "models")), []);
		assert.equal(harness.statusCalls.filter((entry) => entry.value === undefined).length, 1);
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
