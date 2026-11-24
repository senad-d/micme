import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";

const { reloadMicmeConfig, getTranscriptionModeProfile } = await import("../src/config.ts");
const { buildConfigurationItems, createModelSelector, showConfiguration, uniqueStrings } = await import("../src/settings.ts");
const { resolveTranscriptionPlan } = await import("../src/backends.ts");
const { buildRecorderCommand } = await import("../src/audio.ts");

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

function mockPlatform(t, platform) {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	t.after(() => Object.defineProperty(process, "platform", original));
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
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
			const rendered = harness.component.render(100).join("\n");
			return config.MICME_AUTO_DOWNLOAD_MODEL === "0" && !rendered.includes("Saving MICME_AUTO_DOWNLOAD_MODEL");
		}, "auto-download setting did not finish saving");

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
			const rendered = harness.component.render(100).join("\n");
			return config.MICME_SHORTCUT === "~" && !Object.hasOwn(config, "MICME_PRINTABLE_SHORTCUTS") && !rendered.includes("Saving MICME_SHORTCUT");
		}, "shortcut setting did not finish saving");

		saved = JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
		assert.equal(saved.MICME_SHORTCUT, "~");
		assert.equal(Object.hasOwn(saved, "MICME_PRINTABLE_SHORTCUTS"), false);
		assert.ok(harness.renderRequests > 0);

		harness.component.handleInput("\x1b");
		harness.component.handleInput("\x1b");
		assert.equal(harness.doneCount, 1);
	});
});

test("the Windows microphone picker saves a discovered name with both spaces for recorder argv", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	mockPlatform(t, "win32");
	await withTempAgent(t, (root) => withEnv({
		PATHEXT: ".EXE",
		MICME_AUDIO_DEVICE: undefined,
		MICME_DSHOW_AUDIO_DEVICE: undefined,
		MICME_RECORD_COMMAND: undefined,
	}, async () => {
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "ffmpeg.EXE"), [
			"#!/bin/sh",
			"echo 'DirectShow audio devices' >&2",
			"echo '\"Studio Mic\"' >&2",
			"echo '\"Studio  Mic\"' >&2",
			"exit 1",
		].join("\n"), { mode: 0o755 });
		const configPath = join(root, "micme.json");
		await writeFile(configPath, JSON.stringify({ MICME_AUDIO_DEVICE: "Studio Mic", MICME_DSHOW_AUDIO_DEVICE: "Studio Mic" }));
		const harness = createHarness(root);

		await showConfiguration(harness.ctx);
		await waitFor(() => !harness.component.render(100).join("\n").includes("Loading "), "configuration discovery did not finish");
		harness.component.handleInput("/");
		typeText(harness.component, "Microphone device");
		harness.component.handleInput("\r");
		await waitFor(() => !harness.component.render(100).join("\n").includes("Saving "), "microphone setting did not finish saving");
		harness.component.handleInput("q");

		reloadMicmeConfig();
		const { args } = await buildRecorderCommand(join(root, "raw.wav"));
		assert.equal(args[args.indexOf("-i") + 1], "audio=Studio  Mic");
		assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
			MICME_AUDIO_DEVICE: "Studio Mic",
			MICME_DSHOW_AUDIO_DEVICE: "Studio  Mic",
		});
		const microphone = buildConfigurationItems([], [], theme).find((item) => item.label === "Microphone device");
		assert.equal(microphone?.rawValue, "Studio  Mic");
	}));
});

test("the Windows microphone picker preserves automatic discovery when no microphones are listed", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	mockPlatform(t, "win32");
	await withTempAgent(t, (root) => withEnv({
		PATHEXT: ".EXE",
		MICME_AUDIO_DEVICE: undefined,
		MICME_DSHOW_AUDIO_DEVICE: undefined,
		MICME_RECORD_COMMAND: undefined,
	}, async () => {
		const bin = join(root, "bin");
		const ffmpeg = join(bin, "ffmpeg.EXE");
		await mkdir(bin);
		await writeFile(ffmpeg, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const harness = createHarness(root);

		await showConfiguration(harness.ctx);
		await waitFor(() => !harness.component.render(100).join("\n").includes("Loading "), "configuration discovery did not finish");
		harness.component.handleInput("/");
		typeText(harness.component, "Microphone device");
		harness.component.handleInput("\r");
		await waitFor(() => !harness.component.render(100).join("\n").includes("Saving "), "microphone setting did not finish saving");
		harness.component.handleInput("q");

		await writeFile(ffmpeg, "#!/bin/sh\necho '\" Reconnected  Mic \" (audio)' >&2\necho '\"Other Mic\" (audio)' >&2\nexit 1\n");
		reloadMicmeConfig();
		const { args } = await buildRecorderCommand(join(root, "raw.wav"));
		assert.equal(args[args.indexOf("-i") + 1], "audio= Reconnected  Mic ");
	}));
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

test("a missing model selected after config corruption downloads only after repair and reopen", async (t) => {
	await withTempAgent(t, (root) => withEnv({
		MICME_AUTO_DOWNLOAD_MODEL: "1",
		MICME_TRANSCRIBE_BACKEND: "whisper.cpp",
		MICME_WHISPER_CPP_MODEL: undefined,
	}, async () => {
		const configPath = join(root, "micme.json");
		const modelPath = join(root, "models", "ggml-tiny.en.bin");
		const malformed = "{ invalid json";
		await writeFile(configPath, "{}");
		const fetch = t.mock.method(globalThis, "fetch", async () => new Response("model bytes"));

		const rejected = createHarness(root);
		await openMissingModelPicker(rejected);
		await writeFile(configPath, malformed);
		rejected.component.handleInput("\r");
		await waitFor(() => rejected.component.render(100).join("\n").includes("Save failed"), "model choice was not rejected");
		assert.equal(fetch.mock.callCount(), 0);
		assert.match(rejected.notifications.find((entry) => entry.level === "error")?.message ?? "", /not valid JSON/);
		assert.equal(await readFile(configPath, "utf8"), malformed);
		rejected.component.handleInput("q");

		await writeFile(configPath, "{}");
		const repaired = createHarness(root);
		await openMissingModelPicker(repaired);
		repaired.component.handleInput("\r");
		await waitFor(async () => {
			const saved = JSON.parse(await readFile(configPath, "utf8"));
			return saved.MICME_WHISPER_CPP_MODEL === modelPath && !repaired.component.render(100).join("\n").includes("Saving ");
		}, "model choice was not saved after repair");
		assert.equal(fetch.mock.callCount(), 1);
		assert.equal(await readFile(modelPath, "utf8"), "model bytes");
		repaired.component.handleInput("q");
	}));
});

async function openMissingModelPicker(harness) {
	await showConfiguration(harness.ctx);
	await waitFor(() => !harness.component.render(100).join("\n").includes("Loading "), "configuration discovery did not finish");
	harness.component.handleInput("/");
	typeText(harness.component, "Whisper.cpp model");
	harness.component.handleInput("\r");
	assert.match(harness.component.render(100).join("\n"), /Select whisper\.cpp model/i);
	harness.component.handleInput("\x1b[A");
	assert.match(harness.component.render(100).join("\n"), /→ ○ tiny\.en\s/);
}

test("a settings save rejected by the config writer omits parser excerpts from the notification", async (t) => {
	await withTempAgent(t, async (root) => {
		const configPath = join(root, "micme.json");
		await writeFile(configPath, JSON.stringify({ MICME_AUTO_DOWNLOAD_MODEL: "1" }));
		const harness = createHarness(root);
		await showConfiguration(harness.ctx);
		await waitFor(() => !harness.component.render(100).join("\n").includes("Loading "), "configuration discovery did not finish");
		harness.component.handleInput("\r");
		harness.component.handleInput(" ");
		// The save preflight has run synchronously, but the queued writer has not read the file yet.
		const sentinel = "privacySentinel";
		writeFileSync(configPath, sentinel);

		await waitFor(() => harness.notifications.some((entry) => entry.level === "error"), "save failure was not reported");
		const notification = harness.notifications.find((entry) => entry.level === "error");
		assert.doesNotMatch(notification.message, new RegExp(sentinel));
		assert.ok(notification.message.includes(configPath));
		assert.match(notification.message, /invalid JSON.*Fix or remove it first/);
		assert.equal(await readFile(configPath, "utf8"), sentinel);
		harness.component.handleInput("q");
	});
});

test("configuration screen skips external discovery but shows repair information for malformed config", async (t) => {
	mockPlatform(t, "darwin");
	await withTempAgent(t, async (root) => {
		const configPath = join(root, "micme.json");
		await writeFile(configPath, "{ invalid json");
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "ffmpeg"), "", { mode: 0o755 });
		await writeFile(join(bin, "python3"), "", { mode: 0o755 });
		const harness = createHarness(root);
		const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected discovery process"); });
		syncBuiltinESMExports();
		try {
			await showConfiguration(harness.ctx);
			await nextImmediate();

			assert.equal(spawn.mock.callCount(), 0);
			const notification = harness.notifications[0];
			assert.equal(notification?.level, "warning");
			assert.ok(notification?.message.includes(configPath));
			assert.match(notification.message, /not valid JSON.*Fix it/);
			const rendered = harness.component.render(100).join("\n");
			assert.match(rendered, /micme\.json/);
			assert.match(rendered, /reopen settings to run discovery/);
			assert.doesNotMatch(rendered, /Loading /);
			harness.component.handleInput("q");
			assert.equal(harness.doneCount, 1);
		} finally {
			spawn.mock.restore();
			syncBuiltinESMExports();
		}
	});
});

test("configuration items include discovered candidates and derived visibility", async (t) => {
	mockPlatform(t, "darwin");
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
		assert.equal(audio?.description, "macOS avfoundation audio device id");
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
