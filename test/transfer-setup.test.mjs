import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { reloadMicmeConfig } from "../src/config.ts";
import { showSetup } from "../src/transfer/setup.ts";
import { filterSetupCatalog, setupCatalog, whisperModelCompatibility } from "../src/transfer/settings.ts";

const down = "\x1b[B";
const up = "\x1b[A";
const enter = "\r";
const esc = "\x1b";
const theme = { fg: (_color, text) => text, bold: (text) => text };

async function fixture(t, patch = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme-test-setup-"));
	const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === "PI_CODING_AGENT_DIR" || key.startsWith("MICME_")));
	for (const key of Object.keys(previous)) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(async () => {
		delete process.env.PI_CODING_AGENT_DIR;
		Object.assign(process.env, previous);
		reloadMicmeConfig();
		await rm(root, { recursive: true, force: true });
	});
	const sample = join(root, "seed.wav");
	const model = join(root, "trusted-whisper.bin");
	const models = join(root, "cache");
	const configPath = join(root, "micme.json");
	await mkdir(models);
	await Promise.all([writeFile(model, "manual"), writeFile(sample, "sample")]);
	const config = JSON.stringify({ MICME_WHISPER_CPP_BIN: process.execPath, MICME_WHISPER_CPP_MODEL: model, MICME_MODEL_DIR: models,
		MICME_AUTO_SUBMIT: "1", MICME_RECORD_COMMAND: "trusted-recorder {audio}", ...patch });
	await writeFile(configPath, config);
	reloadMicmeConfig();
	return { root, sample, models, configPath, config };
}

function harness(cwd, answers = {}) {
	let component;
	const notifications = [];
	const trials = [];
	const controller = new AbortController();
	const ctx = { cwd, mode: "tui", ui: {
		custom: (factory) => new Promise((resolve) => {
			component = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, (value) => { component = undefined; resolve(value); });
		}),
		input: async () => answers.input,
		notify: (message) => notifications.push(message),
		setStatus() {},
	} };
	const host = { startReviewTrial: async (input, signal) => { assert.ok(!component); trials.push({ input, signal }); } };
	return {
		work: showSetup(ctx, host, controller.signal), controller, trials, notifications,
		press: (...keys) => { for (const key of keys) component.handleInput(key); },
		async view(text) {
			for (let attempt = 0; attempt < 80; attempt++) {
				if (component?.render(80).join("\n").includes(text)) return component;
				await delay(5);
			}
			assert.fail(`Expected ${text}; got ${component?.render(80).join("\n") ?? "no view"}`);
		},
	};
}

test("reference and local rows are independently discoverable with installed, language and capability filters", async (t) => {
	const { root, models } = await fixture(t);
	await writeFile(join(models, "ggml-tiny.en.bin"), "unchecked bytes");
	const rows = setupCatalog(root);
	assert.equal(rows.filter(({ group }) => group === "reference").length, 73);
	assert.deepEqual(filterSetupCatalog(rows, "installed lang:en").map(({ name }) => name), ["tiny.en"]);
	assert.ok(filterSetupCatalog(rows, "stream moonshine").some(({ key }) => key.includes("moonshine")));
	assert.ok(filterSetupCatalog(rows, "translate lang:en").every(({ group }) => group === "whisper"));
	assert.equal(filterSetupCatalog(rows, "installed stream").length, 0);
	assert.match(whisperModelCompatibility("tiny.en-q5_1", "fr", false), /English-only/);
	assert.match(whisperModelCompatibility("large-v3-turbo", "fr", true), /cannot translate/);
});

test("prerequisite and SDL preview leave saved config intact and never start a trial", async (t) => {
	const { root, configPath, config } = await fixture(t, { MICME_WHISPER_STREAM_BIN: "/legacy/whisper-stream" });
	const view = harness(root);
	await view.view("Micme Setup");
	view.press(enter);
	await view.view("Legacy SDL settings were found and are unchanged");
	view.press(esc);
	await view.view("Micme Setup");
	view.press(esc);
	await view.work;
	assert.equal(await readFile(configPath, "utf8"), config);
	assert.deepEqual(view.trials, []);
});

test("microphone confirmation defaults to Cancel and an explicit start transfers the live session signal", async (t) => {
	const { root, configPath, config } = await fixture(t);
	const view = harness(root);
	await view.view("Micme Setup");
	view.press(up, enter);
	const confirmation = await view.view("Try microphone?");
	assert.match(confirmation.render(40).join("\n"), /→ Cancel/);
	view.press(enter);
	const setup = await view.view("Micme Setup");
	assert.match(setup.render(40).join("\n"), /→ Try It: microphone/);
	assert.deepEqual(view.trials, []);
	view.press(enter);
	await view.view("Try microphone?");
	view.press(down, enter);
	await view.work;
	assert.deepEqual(view.trials, [{ input: { kind: "mic" }, signal: view.controller.signal }]);
	assert.equal(view.trials[0].signal.aborted, false);
	assert.equal(await readFile(configPath, "utf8"), config);
});

test("a local sample is confirmed and transferred as an absolute file without fetching or recording", async (t) => {
	const { root, sample } = await fixture(t);
	const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("Try It never fetches"));
	const view = harness(root, { input: "seed.wav" });
	await view.view("Micme Setup");
	view.press(up, up, enter);
	await view.view("Review local sample?");
	view.press(down, enter);
	await view.work;
	assert.deepEqual(view.trials.map(({ input }) => input), [{ kind: "sample", file: sample }]);
	assert.equal(fetch.mock.callCount(), 0);
});

test("missing and corrupt managed weights prevent the host from starting a review", async (t) => {
	const { root, models } = await fixture(t, { MICME_WHISPER_CPP_MODEL: undefined, MICME_DEFAULT_WHISPER_CPP_MODEL: "tiny.en", MICME_AUTO_DOWNLOAD_MODEL: "1" });
	const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("Try It never fetches"));
	const view = harness(root, { input: "seed.wav" });
	await view.view("Micme Setup");
	view.press(up, up, enter);
	await view.view("Micme Setup");
	assert.match(view.notifications.at(-1) ?? "", /model missing/);
	await writeFile(join(models, "ggml-tiny.en.bin"), "corrupt");
	view.press(enter);
	await view.view("Micme Setup");
	assert.match(view.notifications.at(-1) ?? "", /failed verification/);
	assert.deepEqual(view.trials, []);
	assert.equal(fetch.mock.callCount(), 0);
	view.press(esc);
	await view.work;
});

test("a missing managed selection requires explicit download authorization before networking", async (t) => {
	const { root, configPath, config } = await fixture(t, { MICME_WHISPER_CPP_MODEL: undefined, MICME_AUTO_DOWNLOAD_MODEL: "1" });
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response("invalid model bytes"));
	const view = harness(root);
	await view.view("Micme Setup");
	view.press(down, down, down, enter);
	await view.view("Speech model catalog");
	view.press("tiny.en", enter);
	await view.view("Use for Whisper dictation");
	view.press(enter);
	await view.view("Authorize model download?");
	view.press(enter);
	await view.view("Use for Whisper dictation");
	assert.equal(fetch.mock.callCount(), 0);
	view.press(enter);
	await view.view("Authorize model download?");
	view.press(down, enter);
	await view.view("Use for Whisper dictation");
	assert.equal(fetch.mock.callCount(), 1);
	assert.equal(await readFile(configPath, "utf8"), config);
	view.press(esc);
	await view.view("Speech model catalog");
	view.press(esc);
	await view.view("Micme Setup");
	view.press(esc);
	await view.work;
});
