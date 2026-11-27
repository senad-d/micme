import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_POLISH_PROMPT } from "../src/transfer/contracts.ts";
import { showProcessing } from "../src/transfer/processing-view.ts";

const live = { final: { source: "live", raw: "Original live text.", local: "Original live text.", language: "en", rules: [] }, row: null };
const endpoint = "http://127.0.0.1:8000/v1";
const theme = { fg: (_color, text) => text };
const enter = "\r", escape = "\x1b", right = "\x1b[C";
const unix = process.platform === "linux" || process.platform === "darwin";

async function configure(t, settings = {}) {
	const agent = await mkdtemp(join(tmpdir(), "micme-processing-view-"));
	const keys = ["PI_CODING_AGENT_DIR", ...Object.keys(process.env).filter((key) => key.startsWith("MICME_"))];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	t.after(() => rm(agent, { recursive: true, force: true }));
	await writeFile(join(agent, "micme.json"), JSON.stringify({
		MICME_POLISH_PROVIDER: "local-openai", MICME_POLISH_ENDPOINT: endpoint, MICME_POLISH_MODEL: "unit-model",
		...settings,
	}));
}

function harness({ saved = live, mode = "tui" } = {}) {
	const notifications = [], armed = [];
	let panel;
	const tui = { terminal: { rows: 32 }, requestRender: () => {} };
	const ctx = { mode, ui: {
		notify: (message, level) => notifications.push({ message, level }),
		custom: (factory, options) => new Promise((done) => {
			assert.equal(options.overlay, true, "inline prompts restore text by rewriting the editor");
			panel = factory(tui, theme, {}, done);
		}),
	} };
	const host = { lastLive: () => saved, startProcessedClip: (selection) => armed.push(selection) };
	return {
		armed, notifications, tui,
		open: (action, signal = new AbortController().signal) => showProcessing(ctx, host, action, signal),
		paint: (width = 40) => {
			const lines = panel.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			return lines.join("\n");
		},
		key: (data) => panel.handleInput(data),
	};
}

async function until(predicate) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("Timed out waiting for the panel");
}

function chat(text) {
	return Response.json({ choices: [{ message: { content: text } }] });
}

test("clip consent discloses the configured destination and arms only on confirmation", async (t) => {
	await configure(t, { MICME_POLISH_KEY_ENV: "MICME_FIXTURE_KEY" });
	const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("consent never contacts a provider"));
	const ui = harness();
	const dismissed = ui.open("polish");
	const consent = ui.paint(80);
	assert.match(consent, /127\.0\.0\.1:8000\/v1\/chat\/completions/);
	assert.match(consent, /unit-model/);
	assert.match(consent, /MICME_FIXTURE_KEY/);
	assert.match(consent.replace(/\n/g, " "), /no audio or drafts/i);
	assert.match(consent, /Improve punctuation and formatting only/);
	assert.deepEqual(ui.armed, []);
	ui.key(escape);
	await dismissed;
	assert.deepEqual(ui.armed, []);

	const confirmed = ui.open("polish");
	ui.paint();
	ui.key(enter);
	await confirmed;
	assert.equal(ui.armed.length, 1);
	assert.equal(ui.armed[0].provider, "local-openai");
	assert.equal(ui.armed[0].endpoint.href, endpoint);
	assert.equal(ui.armed[0].prompt, DEFAULT_POLISH_PROMPT);
	assert.equal(fetch.mock.callCount(), 0);
});

test("a hosted route requires a configured key name before it can be armed", async (t) => {
	await configure(t, { MICME_POLISH_PROVIDER: "openai", MICME_POLISH_ENDPOINT: "https://api.openai.com/v1", MICME_POLISH_MODEL: "gpt-4.1-mini" });
	const ui = harness();
	const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unconfigured consent never contacts a provider"));
	await ui.open("polish");
	assert.match(ui.notifications[0].message, /key variable name/);
	assert.deepEqual(ui.armed, []);
	assert.equal(fetch.mock.callCount(), 0);
});

test("the configured hook can be chosen without any provider or credential", async (t) => {
	const hook = "/fixtures/trusted-output-hook";
	await configure(t, { MICME_OUTPUT_HOOK: hook });
	const ui = harness();
	const work = ui.open("polish");
	ui.paint();
	ui.key(right); // Polish only.
	ui.key(right); // Hook only.
	const consent = ui.paint();
	assert.match(consent, /Hook only/);
	assert.match(consent, /no provider request/i);
	assert.doesNotMatch(consent, /127\.0\.0\.1/);
	ui.key(enter);
	await work;
	assert.deepEqual(ui.armed, [{ provider: null, endpoint: null, model: "", prompt: "", keyEnv: null, hook }]);
});

test("a scrolled consent cannot be confirmed before the disclosure fits on screen", async (t) => {
	await configure(t, { MICME_POLISH_PROMPT: "Keep identifiers intact. ".repeat(30) });
	const ui = harness();
	ui.tui.terminal.rows = 12;
	const work = ui.open("polish");
	assert.match(ui.paint(), /Enter more/);
	ui.key(enter);
	assert.deepEqual(ui.armed, []);
	for (let i = 0; i < 10 && !ui.paint().includes("Enter confirm"); i++) ui.key(enter);
	assert.match(ui.paint(), /Enter confirm/);
	ui.key(enter);
	await work;
	assert.equal(ui.armed.length, 1);
});

test("preview with no saved live final or without a TUI does not open processing", async () => {
	const noFinal = harness({ saved: null });
	await noFinal.open("preview");
	assert.match(noFinal.notifications[0].message, /no saved live final/i);
	const rpc = harness({ mode: "rpc" });
	await rpc.open("preview");
	assert.match(rpc.notifications[0].message, /interactive TUI/);
});

test("a confirmed preview renders the safe candidate separately from pending work", async (t) => {
	await configure(t);
	const fetch = t.mock.method(globalThis, "fetch", async () => chat("Candidate 17.\x1b]0;private title\x07\u202E"));
	const ui = harness();
	const work = ui.open("preview");
	assert.doesNotMatch(ui.paint(), /Original live text/);
	assert.equal(fetch.mock.callCount(), 0);
	ui.key(enter);
	assert.match(ui.paint(), /Processing saved live final/);
	await until(() => ui.paint().includes("Candidate 17."));
	assert.match(ui.paint(), /Select text to copy/);
	assert.doesNotMatch(ui.paint(), /private title|\u202E/);
	assert.deepEqual(ui.armed, []);
	assert.deepEqual(ui.notifications, []);
	ui.key(escape);
	await work;
});

test("preview publishes stage warnings in order without adding them to the candidate", async (t) => {
	await configure(t, { MICME_OUTPUT_HOOK: "/bin/false" });
	t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 307 }));
	const ui = harness();
	const work = ui.open("preview");
	ui.paint();
	ui.key(enter);
	await until(() => ui.paint().includes(live.final.raw));
	assert.deepEqual(ui.notifications, [
		{ message: "Micme polish: redirect blocked; using the original local transcript.", level: "warning" },
		{ message: "Micme output hook: failed; using the text from before the hook.", level: "warning" },
	]);
	assert.doesNotMatch(ui.paint(), /redirect blocked|output hook: failed/);
	ui.key(escape);
	await work;
});

test("successful empty hook closes preview without a candidate or error warning", { skip: !unix }, async (t) => {
	await configure(t, { MICME_OUTPUT_HOOK: "/bin/true" });
	t.mock.method(globalThis, "fetch", async () => chat("Polished text."));
	const ui = harness();
	const work = ui.open("preview");
	ui.paint();
	ui.key(enter);
	await work;
	assert.doesNotMatch(ui.paint(), /Read only|Polished text/);
	assert.deepEqual(ui.notifications, [
		{ message: "Micme output was empty. No preview was produced; /micme last is unchanged.", level: "info" },
	]);
});

test("Escape during preview aborts processing rather than showing a fallback", async (t) => {
	await configure(t);
	let requestSignal;
	t.mock.method(globalThis, "fetch", (_url, { signal }) => {
		requestSignal = signal;
		return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	});
	const ui = harness();
	const work = ui.open("preview");
	ui.paint();
	ui.key(enter);
	await until(() => requestSignal);
	ui.key(escape);
	await work;
	assert.equal(requestSignal.aborted, true);
	assert.doesNotMatch(ui.paint(), /Original live text/);
	assert.deepEqual(ui.notifications, []);
});
