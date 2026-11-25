import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
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
const { buildLiveRecorderSpec, buildRecorderCommand } = await import("../src/audio.ts");
const { buildLiveWorkerCommand } = await import("../src/streaming.ts");

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

test("the host can unmount settings without leaving discovery or input attached", async (t) => {
	await withTempAgent(t, async (root) => {
		const harness = createHarness(root);
		const shown = showConfiguration(harness.ctx);
		harness.component.dispose();
		await shown;
		assert.equal(harness.doneCount, 1);
		harness.component.handleInput("\t");
		assert.equal(harness.renderRequests, 0);
		assert.deepEqual(harness.notifications, []);
	});
});

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

test("reactive settings decline ambiguous terminal bytes and still capture an unambiguous chord", async (t) => {
	await withTempAgent(t, async (root) => {
		const configPath = join(root, "micme.json");
		await writeFile(configPath, '{"MICME_SHORTCUT":"f8"}');
		const harness = createHarness(root);
		harness.ctx.ui.composer = { addKeyHandler: () => () => undefined };
		await showConfiguration(harness.ctx);
		const { component } = harness;
		component.handleInput("/");
		typeText(component, "shortcut");
		component.handleInput("\r");
		for (const data of ["\x1bB", "\x1bF", "\x08"]) {
			component.handleInput("\x1b[1;3D");
			assert.match(component.render(110).join("\n"), /Captured alt\+left/);
			component.handleInput(data);
			assert.match(component.render(110).join("\n"), /Ambiguous terminal input/);
			component.handleInput("\r");
			assert.match(component.render(110).join("\n"), /Press a shortcut before confirming/);
			assert.equal(JSON.parse(await readFile(configPath, "utf8")).MICME_SHORTCUT, "f8");
		}
		component.handleInput("\x1b[1;3D");
		component.handleInput("\r");
		await waitFor(async () => JSON.parse(await readFile(configPath, "utf8")).MICME_SHORTCUT === "alt+left", "unambiguous shortcut did not save");
		component.close();
	});
});

test("Linux settings and live argv use the same configured input, worker, VAD, ASR and language with shell precedence", { skip: process.platform !== "linux" }, async (t) => {
	await withTempAgent(t, async (root) => {
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "ffmpeg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const worker = join(bin, "Local worker");
		const vad = join(root, "Speech detector.bin");
		const model = join(root, "ggml-base.en.bin");
		for (const path of [worker, vad, model]) await writeFile(path, "fixture", { mode: 0o755 });
		const configPath = join(root, "micme.json");
		const config = {
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_TRANSCRIBE_BACKEND: "auto",
			MICME_LANGUAGE: "auto",
			MICME_WHISPER_CPP_MODEL: model,
			MICME_LIVE_BIN: worker,
			MICME_VAD_MODEL: vad,
		};
		await writeFile(configPath, JSON.stringify(config));
		const defaults = createHarness(root);
		await openSettingsPane(defaults, 3);
		assert.match(defaults.component.render(100).join("\n"), /Microphone device\s+default/);
		assert.match(defaults.component.render(100).join("\n"), /MICME_PULSE_SOURCE.*micme.json/);
		defaults.component.handleInput("q");

		config.MICME_PULSE_SOURCE = "studio.monitor";
		await writeFile(configPath, JSON.stringify(config));
		await assertEffectiveLinuxSettings(root, config);

		const overrides = { MICME_PULSE_SOURCE: "shell.monitor", MICME_LIVE_BIN: join(bin, "Shell worker"), MICME_VAD_MODEL: join(root, "Shell detector.bin") };
		await writeFile(overrides.MICME_LIVE_BIN, "fixture", { mode: 0o755 });
		await writeFile(overrides.MICME_VAD_MODEL, "fixture");
		await withEnv(overrides, () => assertEffectiveLinuxSettings(root, { ...config, ...overrides }, true));
	});
});

async function openSettingsPane(harness, category) {
	await showConfiguration(harness.ctx);
	await waitFor(() => !harness.component.render(100).join("\n").includes("Loading "), "configuration discovery did not finish");
	for (let index = 0; index < category; index++) harness.component.handleInput("\x1b[B");
	harness.component.handleInput("\r");
}

async function assertEffectiveLinuxSettings(root, config, shellOverride = false) {
	const harness = createHarness(root);
	await openSettingsPane(harness, 2);
	const stream = harness.component.render(160).join("\n");
	assert.match(stream, /Live decoder/);
	assert.ok(stream.includes(config.MICME_LIVE_BIN));
	assert.match(stream, /MICME_LIVE_BIN.*micme\.json/);
	if (shellOverride) assert.match(stream, /Shell override: MICME_LIVE_BIN/);
	const narrow = harness.component.render(40);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 40));
	assert.match(narrow.join("\n"), /MICME_LIVE_BIN/);
	assert.match(narrow.join("\n"), /restart Pi/);
	harness.component.handleInput("\r");
	assert.doesNotMatch(harness.component.render(100).join("\n"), /Saving /);
	harness.component.handleInput("\x1b[B");
	const vad = harness.component.render(160).join("\n");
	assert.ok(vad.includes(config.MICME_VAD_MODEL));
	assert.match(vad, /MICME_VAD_MODEL.*micme\.json/);
	harness.component.handleInput("\t");
	harness.component.handleInput("\x1b[B");
	harness.component.handleInput("\r");
	const audio = harness.component.render(100).join("\n");
	assert.ok(audio.includes(config.MICME_PULSE_SOURCE));
	if (shellOverride) assert.match(audio, /Shell override: MICME_PULSE_SOURCE/);

	const live = resolveTranscriptionPlan({ transcriptionMode: "stream" }).live;
	const worker = buildLiveWorkerCommand(live);
	assert.equal(worker.command, config.MICME_LIVE_BIN);
	assert.deepEqual(worker.args, ["--model", config.MICME_WHISPER_CPP_MODEL, "--vad-model", config.MICME_VAD_MODEL, "--language", "en"]);
	const recorder = await buildLiveRecorderSpec(join(root, "raw.wav"), root, new AbortController().signal);
	assert.equal(recorder.args[recorder.args.indexOf("-i") + 1], config.MICME_PULSE_SOURCE);
	if (!shellOverride) {
		harness.component.handleInput("\r");
		await waitFor(async () => {
			const saved = JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
			return saved.MICME_PULSE_SOURCE === "default" && !harness.component.render(100).join("\n").includes("Saving ");
		}, "did not cycle from an unlisted Pulse source back to the discovered default");
	}

	harness.component.handleInput("\t");
	harness.component.handleInput("\x1b[B");
	harness.component.handleInput("\r");
	harness.component.handleInput("\x1b[B");
	assert.match(harness.component.render(100).join("\n"), /Live language: en/);
	harness.component.handleInput("q");
}

test("stream settings show the installed default ASR model used in the worker argv", async (t) => {
	await withTempAgent(t, async (root) => {
		const modelDir = join(root, "models");
		const liveDefault = join(modelDir, "ggml-base.en.bin");
		await mkdir(modelDir);
		await writeFile(liveDefault, "installed ASR fixture");
		await writeFile(join(root, "micme.json"), JSON.stringify({
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_TRANSCRIBE_BACKEND: "auto",
			MICME_LIVE_BIN: process.execPath,
		}));

		const harness = createHarness(root);
		await openSettingsPane(harness, 1);
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\x1b[B");
		const rendered = harness.component.render(160).join("\n");
		assert.match(rendered, /ASR model/);
		assert.ok(rendered.includes(liveDefault), rendered);
		assert.doesNotMatch(rendered, /small\.en|ASR model file is missing/);
		const worker = buildLiveWorkerCommand(resolveTranscriptionPlan({ transcriptionMode: "stream" }).live);
		assert.equal(worker.args[worker.args.indexOf("--model") + 1], liveDefault);
		harness.component.handleInput("q");
	});
});

test("settings show missing live components without suggesting they are ready", async (t) => {
	await withTempAgent(t, async (root) => {
		const bin = join(root, "bin");
		await mkdir(bin);
		const configPath = join(root, "micme.json");
		const worker = join(bin, "micme-live");
		const config = { MICME_TRANSCRIPTION_MODE: "stream", MICME_LIVE_BIN: worker, MICME_VAD_MODEL: join(root, "absent-vad.bin"), MICME_WHISPER_CPP_MODEL: join(root, "absent-asr.bin") };
		await writeFile(configPath, JSON.stringify(config));
		const missingWorker = createHarness(root);
		await openSettingsPane(missingWorker, 2);
		assert.match(missingWorker.component.render(100).join("\n"), /MICME_LIVE_BIN is set but not found/);
		missingWorker.component.handleInput("q");

		await writeFile(worker, "fixture", { mode: 0o755 });
		const missingWeights = createHarness(root);
		await openSettingsPane(missingWeights, 2);
		missingWeights.component.handleInput("\x1b[B");
		assert.match(missingWeights.component.render(100).join("\n"), /Speech detector model file is missing/);
		missingWeights.component.handleInput("\t");
		missingWeights.component.handleInput("\x1b[A");
		missingWeights.component.handleInput("\r");
		for (let index = 0; index < 2; index++) missingWeights.component.handleInput("\x1b[B");
		assert.match(missingWeights.component.render(100).join("\n"), /ASR model file is missing/);
		missingWeights.component.handleInput("q");
	});
});

test("the live final pass and diagnostics switches reflect effective flags and save to their live config keys", async (t) => {
	await withTempAgent(t, async (root) => {
		const configPath = join(root, "micme.json");
		await writeFile(configPath, JSON.stringify({ MICME_STREAM_FINALIZE_WITH_CLIP: "yes", MICME_STREAM_DIAGNOSTICS: " on " }));
		const harness = createHarness(root);
		await openSettingsPane(harness, 2);
		assert.match(harness.component.render(100).join("\n"), /Stream final pass\s+ON/);
		harness.component.handleInput("\x1b[A");
		harness.component.handleInput("\r");
		await waitFor(() => /Stream final pass\s+OFF/.test(harness.component.render(100).join("\n")), "live final pass was not disabled");
		harness.component.handleInput("\t");
		harness.component.handleInput("\x1b[A");
		harness.component.handleInput("\x1b[A");
		harness.component.handleInput("\r");
		assert.match(harness.component.render(100).join("\n"), /Stream diagnostics\s+ON/);
		harness.component.handleInput("\x1b[A");
		harness.component.handleInput("\r");
		await waitFor(() => /Stream diagnostics\s+OFF/.test(harness.component.render(100).join("\n")), "live diagnostics were not disabled");
		assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { MICME_STREAM_FINALIZE_WITH_CLIP: "0", MICME_STREAM_DIAGNOSTICS: "0" });
		harness.component.handleInput("q");
	});
});

test("macOS settings identify the effective explicit AVFoundation input instead of an inactive picker", async (t) => {
	mockPlatform(t, "darwin");
	await withTempAgent(t, async (root) => {
		const configPath = join(root, "micme.json");
		const config = { MICME_AUDIO_DEVICE: "1", MICME_AVFOUNDATION_INPUT: ":Override Mic" };
		await writeFile(configPath, JSON.stringify(config));
		const harness = createHarness(root);
		await openSettingsPane(harness, 3);
		const audio = harness.component.render(100).join("\n");
		assert.match(audio, /Microphone device\s+:Override Mic/);
		assert.match(audio, /MICME_AVFOUNDATION_INPUT overrides MICME_AUDIO_DEVICE/);
		harness.component.handleInput("\r");
		assert.doesNotMatch(harness.component.render(100).join("\n"), /Saving /);
		assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), config);
		harness.component.handleInput("q");
	});
});

test("audio settings report a custom capture override without displaying the command", async (t) => {
	await withTempAgent(t, async (root) => {
		await writeFile(join(root, "micme.json"), JSON.stringify({ MICME_RECORD_COMMAND: "private-recorder-options {audio}" }));
		const harness = createHarness(root);
		await openSettingsPane(harness, 3);
		const audio = harness.component.render(100).join("\n");
		assert.match(audio, /Microphone device\s+Custom recorder/);
		assert.match(audio, /MICME_RECORD_COMMAND/);
		assert.doesNotMatch(audio, /private-recorder-options/);
		harness.component.handleInput("q");
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

		assert.deepEqual(items.filter((item) => item.categoryId === "streaming").map((item) => item.id), ["MICME_LIVE_BIN", "MICME_VAD_MODEL", "MICME_STREAM_FINALIZE_WITH_CLIP"]);
		assert.ok(ids.includes("MICME_STREAM_DIAGNOSTICS"));
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

test("configuration renders a selected Python discovery label without terminal styling", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	await withTempAgent(t, (root) => withEnv({
		MICME_TRANSCRIPTION_MODE: undefined,
		MICME_TRANSCRIBE_BACKEND: undefined,
		MICME_WHISPER_MODEL: undefined,
	}, async () => {
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "python3"), "#!/bin/sh\nprintf '\\033[31mdiscovered-model\\033[0m\\n'\n", { mode: 0o755 });
		const configPath = join(root, "micme.json");
		await writeFile(configPath, JSON.stringify({ MICME_TRANSCRIPTION_MODE: "clip", MICME_TRANSCRIBE_BACKEND: "python", MICME_WHISPER_MODEL: "small" }));
		const harness = createHarness(root);

		await showConfiguration(harness.ctx);
		await waitFor(() => !harness.component.render(100).join("\n").includes("Loading "), "configuration discovery did not finish");
		harness.component.handleInput("/");
		typeText(harness.component, "Model name passed to the OpenAI Whisper Python CLI");
		harness.component.handleInput("\r");
		await waitFor(async () => {
			const config = JSON.parse(await readFile(configPath, "utf8"));
			return config.MICME_WHISPER_MODEL === "\x1b[31mdiscovered-model\x1b[0m" && !harness.component.render(100).join("\n").includes("Saving ");
		}, "discovered Python model was not selected");

		const modelRow = harness.component.render(100).find((line) => line.includes("Model (Transcription)"));
		assert.match(modelRow ?? "", /Model \(Transcription\) +discovered-model *│$/);
		harness.component.handleInput("q");
	}));
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

test("the Pi model selector honors remapped navigation, confirm, and cancel before filtering", (t) => {
	const previous = getKeybindings();
	t.after(() => setKeybindings(previous));
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.down": "ctrl+n",
		"tui.select.confirm": "y",
		"tui.select.cancel": "n",
	}));
	const candidates = [
		{ label: "Tiny", value: "tiny", description: "local", installed: true, kind: "model-name" },
		{ label: "Base", value: "base", description: "local", installed: true, kind: "model-name" },
	];
	const selected = [];
	const selector = createModelSelector(candidates, theme, (value) => selected.push(value));
	selector.handleInput("\x0e");
	selector.handleInput("\r");
	assert.deepEqual(selected, [], "the old confirmation key must not select");
	selector.handleInput("y");
	assert.deepEqual(selected, ["base"]);
	const second = createModelSelector(candidates, theme, (value) => selected.push(value));
	second.handleInput("n");
	assert.deepEqual(selected, ["base", undefined]);
});

test("model selector filters by keyboard without selecting a hidden model", () => {
	const selected = [];
	const selector = createModelSelector([
		{ label: "Tiny", value: "tiny", description: "local", installed: true },
		{ label: "Base", value: "base", description: "download", installed: false },
	], theme, (value) => selected.push(value));
	typeText(selector, "basx");
	assert.match(selector.render(48).join("\n"), /No matching models/);
	selector.handleInput("\r");
	assert.deepEqual(selected, []);
	selector.handleInput("\x7f");
	assert.match(selector.render(48).join("\n"), /→ ○ Base/);
	selector.handleInput("\r");
	assert.deepEqual(selected, ["base"]);
});
