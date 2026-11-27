import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { currentLibraryModel, LibraryScreen, showLibrary } from "../src/transfer/history-view.ts";

const enter = "\r", up = "\x1b[A", down = "\x1b[B", escape = "\x1b", pageDown = "\x1b[6~", next = "\x07";
const currentModel = { variantId: "current", compute: "cpu", requestedDeviceId: null, language: "en", task: "transcribe", detector: "off", chunking: true };
const savedAudio = { bytes: 42, sha256: "a".repeat(64) };
const theme = { fg: (_color, text) => text };
const project = "/isolated";

function take(id, data = {}) {
	return { id, createdUtc: "2026-11-26T01:00:00.000Z", source: "clip", filename: null, language: "en", raw: null, local: null, polished: null,
		modelId: "previous", starred: false, state: "ready", doneSamples: 0, totalSamples: null, wav: null, ...data };
}

function harness(t, overrides = {}, action = "history", width = 40) {
	const controller = new AbortController();
	let dismissed = 0;
	const screen = new LibraryScreen(project, action, { terminal: { rows: 24 }, requestRender() {} }, theme, controller.signal, () => { dismissed += 1; }, {
		enabled: () => true, page: async () => [], currentModel: async () => currentModel, ...overrides,
	});
	t.after(() => screen.finish());
	const paint = () => {
		const lines = screen.render(width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `too wide: ${line}`);
		return lines.join("\n");
	};
	const press = (...keys) => { for (const key of keys) screen.handleInput(key); };
	const choose = async (label) => {
		await tick();
		for (let i = 0; i < 32; i++) press(up);
		for (let i = 0; i < 32; i++) {
			if (paint().split("\n").some((line) => line.startsWith(`→ ${label}`))) { press(enter); await tick(); return; }
			press(down);
		}
		assert.fail(`${label} not selectable:\n${paint()}`);
	};
	return { paint, press, choose, signal: controller, dismissed: () => dismissed };
}

function untilAbort(signal) {
	return new Promise((_done, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

test("noninteractive library invocation does not create a screen", async (t) => {
	const custom = t.mock.fn();
	const ctx = { mode: "rpc", ui: { custom } };
	for (const action of ["history", "import"]) await showLibrary(ctx, action, new AbortController().signal);
	assert.equal(custom.mock.callCount(), 0);
});

test("history off does not read storage and opt-in requires explicit confirmation", async (t) => {
	let writes = 0, reads = 0;
	const ui = harness(t, { enabled: () => writes > 0, page: async () => { reads++; return []; }, setEnabled: async (enable) => { assert.equal(enable, true); writes++; } });
	await ui.choose("Enable local history");
	assert.match(ui.paint(), /Not\s+encrypted/);
	ui.press(enter); // Defaults to Cancel.
	assert.deepEqual([reads, writes], [0, 0]);
	await ui.choose("Enable local history");
	await ui.choose("Enable history");
	assert.deepEqual([reads, writes], [1, 1]);
	assert.match(ui.paint(), /Local history enabled/);
});

test("storage failure is not shown as an empty or disabled library", async (t) => {
	const ui = harness(t, { page: async () => { throw new Error("private path"); } });
	await tick();
	assert.match(ui.paint(), /Storage error/);
	assert.doesNotMatch(ui.paint(), /private path|No saved takes|history is off/);
});

test("newest-first keyboard list can page older and newer with the service cursor", async (t) => {
	const first = Array.from({ length: 20 }, (_, i) => take(`new-${i}`, { filename: `take ${i}` }));
	const reads = [];
	const ui = harness(t, { page: async (before) => { reads.push(before); return before ? [take("old", { filename: "oldest take" })] : first; } });
	await ui.choose("Older takes");
	assert.match(ui.paint(), /Page 2[\s\S]*oldest take/);
	await ui.choose("Newer takes");
	assert.match(ui.paint(), /Page 1[\s\S]*take 0/);
	assert.deepEqual(reads, [null, "new-19", null]);
});

test("failed delivery exposes separately copyable text but not missing audio actions", async (t) => {
	const copied = [];
	const original = "Original words\u001b]8;;https://example.test\u0007 here\u202e.";
	const ui = harness(t, {
		page: async () => [take("text", { state: "delivery-failed", raw: original, local: "Local rewrite.", polished: "Polished words." })],
		copy: async (text) => { copied.push(text); },
	});
	await ui.choose("clip · Delivery failed");
	assert.match(ui.paint(), /Saved text is still copyable/);
	assert.match(ui.paint(), /No verified saved audio/);
	assert.doesNotMatch(ui.paint(), /Play saved|Retry with current/);
	await ui.choose("Original transcript");
	assert.match(ui.paint(), /Original words {2}here\./);
	assert.doesNotMatch(ui.paint(), /example\.test|\u202e/);
	assert.deepEqual(copied, []);
	ui.press(enter);
	await tick();
	assert.match(ui.paint(), /Copy requested/);
	ui.press(escape);
	await ui.choose("Polished transcript");
	ui.press(enter);
	await tick();
	assert.deepEqual(copied, [original, "Polished words."]);
});

test("unavailable clipboard leaves the full transcript navigable for manual selection", async (t) => {
	const transcript = Array.from({ length: 50 }, (_, i) => `public text line ${i + 1}`).join("\n");
	const ui = harness(t, {
		page: async () => [take("long", { local: transcript })], copy: async () => { throw new Error("Unavailable"); },
	}, "history", 80);
	await ui.choose("clip · Ready");
	await ui.choose("Local transcript");
	ui.press(enter);
	await tick();
	assert.match(ui.paint(), /Clipboard unavailable[\s\S]*copy it manually[\s\S]*public text line 1\n/);
	assert.doesNotMatch(ui.paint(), /public text line 50/);
	ui.press(pageDown, pageDown, pageDown);
	assert.match(ui.paint(), /public text line 50/);
});

test("a WAV receipt alone does not offer playback or retry", async (t) => {
	const audioChecks = [];
	const ui = harness(t, { page: async () => [take("replaced", { wav: savedAudio })], verifiedAudio: async (id) => { audioChecks.push(id); return null; } });
	await ui.choose("clip · Ready");
	assert.deepEqual(audioChecks, ["replaced"]);
	assert.match(ui.paint(), /No verified saved audio/);
	assert.doesNotMatch(ui.paint(), /Play saved|Retry with current/);
});

test("seek starts at the requested offset only after the prior player stops", async (t) => {
	const events = [];
	const ui = harness(t, {
		page: async () => [take("audio", { wav: savedAudio })], verifiedAudio: async () => savedAudio,
		async play(id, from, signal) { events.push([id, "play", from]); try { await untilAbort(signal); } finally { events.push([id, "stop", from]); } },
	});
	await ui.choose("clip · Ready");
	await ui.choose("Play saved audio");
	await ui.choose("Seek…");
	ui.press("-", "1", enter);
	assert.match(ui.paint(), /nonnegative/);
	ui.press(escape);
	await ui.choose("Seek…");
	ui.press("2", ".", "5", enter);
	await tick();
	assert.match(ui.paint(), /Playback requested from 2.5s/);
	assert.deepEqual(events, [["audio", "play", 0], ["audio", "stop", 0], ["audio", "play", 2500]]);
	await ui.choose("Stop playback");
	assert.deepEqual(events.at(-1), ["audio", "stop", 2500]);
});

test("file retry selects the current live-profile weights without needing the live worker", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-library-model-"));
	const modelDir = join(root, "models");
	const binary = join(root, "whisper-cli");
	const settings = {
		PI_CODING_AGENT_DIR: root, MICME_TRANSCRIPTION_MODE: "stream", MICME_TRANSCRIBE_BACKEND: "whisper.cpp",
		MICME_MODEL_DIR: modelDir, MICME_WHISPER_CPP_BIN: binary, MICME_LIVE_BIN: join(root, "missing-live-worker"),
	};
	const keys = new Set([...Object.keys(settings), ...Object.keys(process.env).filter((key) => key.startsWith("MICME_"))]);
	const previous = new Map([...keys].map((key) => [key, process.env[key]]));
	t.after(async () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	for (const key of keys) delete process.env[key];
	Object.assign(process.env, settings);
	await mkdir(modelDir);
	await writeFile(join(modelDir, "ggml-base.en.bin"), "Fixture representing an installed model; not used for inference.");
	await writeFile(binary, "#!/bin/sh\nexit 2\n", { mode: 0o700 });
	const choice = await currentLibraryModel(new AbortController().signal);
	assert.match(choice.variantId, /base\.en/);
	assert.equal(choice.detector, "off");
});

test("retry binds the current installed choice and can be canceled without replacing earlier text", async (t) => {
	const started = [];
	let row = take("retry", { wav: savedAudio, raw: "Earlier final" });
	const ui = harness(t, {
		page: async () => [row], verifiedAudio: async () => savedAudio,
		async retry(id, choice, signal) {
			started.push([id, choice]);
			const before = row;
			row = { ...row, state: "recognizing", doneSamples: 10, totalSamples: 20 };
			try { await untilAbort(signal); } finally { row = before; }
		},
	});
	await ui.choose("clip · Ready");
	await ui.choose("Retry with current model");
	assert.match(ui.paint(), /Current model: current\./);
	await ui.choose("Start retry");
	const progress = /10\/20 samples processed[\s\S]*Cancel retry/;
	for (let i = 0; i < 50 && !progress.test(ui.paint()); i++) await delay(25);
	assert.match(ui.paint(), progress);
	ui.press(escape);
	await tick();
	assert.match(ui.paint(), /Canceled/);
	assert.deepEqual(started, [["retry", currentModel]]);
	await ui.choose("Original transcript");
	assert.match(ui.paint(), /Earlier final/);
});

test("star and confirmed delete address the selected row and restore the nearest surviving focus", async (t) => {
	let rows = [take("a", { filename: "first take" }), take("b", { filename: "second take" })];
	const actions = [];
	const ui = harness(t, {
		page: async () => rows,
		star: async (id, on) => { actions.push([id, on]); rows = rows.map((r) => r.id === id ? { ...r, starred: on } : r); },
		deleteRow: async (id) => { actions.push([id]); rows = rows.filter((r) => r.id !== id); },
	});
	await ui.choose("clip · Ready · first take");
	await ui.choose("Star take");
	assert.match(ui.paint(), /Starred · protected/);
	await ui.choose("Delete take…");
	ui.press(enter);
	assert.deepEqual(actions, [["a", true]]);
	await ui.choose("Delete take…");
	await ui.choose("Delete take");
	assert.deepEqual(actions, [["a", true], ["a"]]);
	assert.match(ui.paint(), /→ clip · Ready · second take/);
});

test("retention exposes exact candidates, makes cancel safe and applies the original preview object", async (t) => {
	let pending, applied;
	const ui = harness(t, {
		proposedRetention: () => ({ kind: "count", count: 1 }),
		previewPrune: async (policy) => (pending = Object.freeze({ ids: ["eligible-id"], policy, bytes: 12345 })),
		applyPrune: async (plan) => { applied = plan; },
	});
	await ui.choose("Retention");
	await ui.choose("Preview configured policy");
	assert.match(ui.paint(), /Delete 1 take\(s\) and 12345 bytes/);
	await ui.choose("View affected take IDs");
	assert.match(ui.paint(), /eligible-id/);
	ui.press(escape, escape);
	assert.equal(applied, undefined);
	await ui.choose("Preview configured policy");
	await ui.choose("Apply retention");
	assert.equal(applied, pending);
	assert.match(ui.paint(), /Retention applied: count:1/);
});

test("import passes literal multiline paths and the fixed installed choice only after confirmation", async (t) => {
	const submissions = [];
	const ui = harness(t, {
		listInstalled: async () => [currentModel],
		localImport: async () => ({ files: async (...args) => { submissions.push(args); return ["id-a", "id-b"]; }, cancel() {} }),
	}, "import");
	await ui.choose("Add files");
	ui.press("\x1b[200~subdir/../one file.wav\x1b[201~", enter, "\x1b[200~/other/track $2.opus \x1b[201~", next);
	await ui.choose("current");
	assert.match(ui.paint(), /2 file\(s\) · current/);
	assert.deepEqual(submissions, []);
	await ui.choose("Queue files");
	assert.deepEqual(submissions[0].slice(0, 2), [[`${project}${sep}subdir/../one file.wav`, "/other/track $2.opus "], currentModel]);
	ui.press(escape);
	assert.equal(ui.dismissed(), 1);
	assert.equal(submissions[0][2].aborted, false);
	ui.signal.abort();
	assert.equal(submissions[0][2].aborted, true);
});

test("file input rejects empty input and URLs before model lookup", async (t) => {
	let lookups = 0;
	const ui = harness(t, { listInstalled: async () => { lookups++; return []; } }, "import");
	await ui.choose("Add files");
	ui.press(next);
	assert.match(ui.paint(), /Enter at least one local path/);
	ui.press("\x1b[200~https://example.test/test.wav\x1b[201~", next);
	assert.match(ui.paint(), /literal local file paths, not URLs/);
	assert.equal(lookups, 0);
});

test("pasted terminal control characters are rejected before being rendered as a path", async (t) => {
	const ui = harness(t, {}, "import");
	await ui.choose("Add files");
	ui.press("\x1b[200~\u009d8;;https://example.test\u009c\x1b[201~");
	assert.match(ui.paint(), /unsupported control\s+characters/);
	assert.doesNotMatch(ui.paint(), /example\.test/);
});

test("active import reports per-file progress and its cancel action targets that job", async (t) => {
	const canceled = [];
	let row = take("job", { source: "import", filename: "public audio.opus", state: "recognizing", doneSamples: 17, totalSamples: 75 });
	const ui = harness(t, { page: async () => [row], localImport: async () => ({ cancel(id) { canceled.push(id); row = { ...row, state: "canceled" }; } }) }, "import", 80);
	await ui.choose("import · Transcribing · public audio.opus");
	assert.match(ui.paint(), /17\/75 samples processed/);
	await ui.choose("Cancel file job");
	assert.deepEqual(canceled, ["job"]);
	assert.match(ui.paint(), /import · Canceled[\s\S]*Reselect source file/);
});
