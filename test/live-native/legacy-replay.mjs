import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const clear = "\x1b[2K\r";
const redraw = `${clear}${" ".repeat(100)}${clear}`;
const guess = "The ocean is blue";
const corrected = "Please open system settings";
const marker = "[BLANK_AUDIO]";
const cases = {
	"two rewrites": { stdout: `${redraw}${guess}${redraw}${corrected}\n`, receipt: { rawFrame: corrected, extractionMode: "incremental" },
		before: guess, after: `${guess} ${corrected}`, desired: corrected },
	"ANSI-only silence": { stdout: `${redraw}${redraw}\n`, receipt: { rawFrame: "", extractionMode: "ignored" }, before: "", after: "", desired: "" },
	"literal [BLANK_AUDIO] silence": { stdout: `${redraw}${marker}\n`, receipt: { rawFrame: marker, extractionMode: "reset" }, before: "", after: "", desired: "" },
	"pending guess then ANSI-only silence": { stdout: `${redraw}${guess}${redraw}\n`, receipt: { rawFrame: "", extractionMode: "ignored", candidateWords: guess.split(" ") },
		before: "", after: guess, desired: "" },
	"pending guess then literal [BLANK_AUDIO]": { stdout: `${redraw}${guess}${redraw}${marker}\n`, receipt: { rawFrame: marker, extractionMode: "reset", candidateWords: [] },
		before: "", after: "", desired: "" },
};

async function fixture(trigger, input) {
	const stop = () => process.exit(0);
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	while (!existsSync(trigger)) await delay(5);
	process.stdout.write(readFileSync(input));
	setInterval(() => {}, 1_000);
}

function context(cwd) {
	let editor = "";
	const editorWrites = [];
	const frames = [];
	const notices = [];
	const replay = [];
	const sent = [];
	const hooks = new Map();
	const ctx = { cwd, mode: "tui", hasUI: true, isIdle: () => true,
		ui: {
			theme: { fg: (_kind, text) => text, bold: (text) => text },
			getEditorText: () => editor,
			setEditorText: (text) => { editor = text; editorWrites.push(text); },
			pasteToEditor: (text) => { replay.push(text); },
			getEditorComponent: () => undefined, setEditorComponent() {}, setWidget() {}, setStatus() {},
			notify(message, level) {
				if (message.startsWith("Micme stream frame: ")) frames.push(JSON.parse(message.slice(20)));
				else notices.push({ message, level });
			},
		},
	};
	return { ctx, frames, notices, editorWrites, replay, sent, editor: () => editor.trim(), hooks,
		pi: { registerCommand: (name, { handler }) => hooks.set(name, handler), on: (name, handler) => hooks.set(name, handler),
			registerShortcut() {}, registerMessageRenderer() {}, sendUserMessage: (text) => sent.push(text) },
		command: (args = "") => hooks.get("micme")(args, ctx),
	};
}

async function replayCase(register, work, model, name, spec, index) {
	const dir = join(work, String(index));
	await mkdir(dir);
	const trigger = join(dir, "emit");
	const input = join(dir, "stdout");
	const binary = join(dir, "whisper-stream.mjs");
	await writeFile(input, spec.stdout);
	await writeFile(binary, `#!${process.execPath}\nimport ${JSON.stringify(import.meta.url + "?fixture=" + encodeURIComponent(JSON.stringify([trigger, input])))};\n`, { mode: 0o700 });
	Object.assign(process.env, { MICME_WHISPER_CPP_MODEL: model, MICME_WHISPER_STREAM_BIN: binary });
	const ui = context(dir);
	const owner = register(ui.pi);
	try {
		await ui.hooks.get("session_start")({}, ui.ctx);
		await ui.command();
		assert.equal(owner.getPhase(), "streaming", JSON.stringify(ui.notices));
		await writeFile(trigger, "");
		const limit = performance.now() + 1_500;
		while (!ui.frames.some((frame) => matches(frame, spec.receipt)) && performance.now() < limit) await delay(5);
		assert.ok(ui.frames.some((frame) => matches(frame, spec.receipt)), `${name}: stdout not observed: ${JSON.stringify(ui.frames)}`);
		const beforeStop = ui.editor();
		await ui.command();
		assert.equal(owner.getPhase(), "idle");
		const atStop = ui.editor();
		await ui.command("last");
		assert.equal(ui.notices.some(({ level }) => level === "error"), false, JSON.stringify(ui.notices));
		assert.equal(beforeStop, spec.before, name);
		assert.equal(atStop, spec.after, name);
		assert.deepEqual(ui.replay.map((s) => s.trim()), atStop ? [atStop] : [], name);
		assert.deepEqual(ui.sent, []);
		return { name, stdout: spec.stdout, beforeStop, atStop, desired: spec.desired, meetsDesired: atStop === spec.desired,
			editorWrites: ui.editorWrites, replay: ui.replay, sent: ui.sent, frames: ui.frames, warnings: ui.notices.filter(({ level }) => level === "warning") };
	} finally {
		await ui.hooks.get("session_shutdown")({}, ui.ctx);
	}
}

function matches(frame, fields) {
	return Object.keys(fields).every((key) => JSON.stringify(frame[key]) === JSON.stringify(fields[key]));
}

async function evaluate(baseline, output) {
	const work = await mkdtemp(join(tmpdir(), "micme-legacy-replay-"));
	try {
		const agent = join(work, "pi-agent");
		await mkdir(agent);
		for (const key of Object.keys(process.env)) if (key.startsWith("MICME_")) delete process.env[key];
		Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, MICME_TRANSCRIPTION_MODE: "stream", MICME_TRANSCRIBE_BACKEND: "whisper.cpp",
			MICME_STREAM_DIAGNOSTICS: "1", MICME_STREAM_FINALIZE_WITH_CLIP: "0", MICME_AUTO_SUBMIT: "0", MICME_AUTO_DOWNLOAD_MODEL: "0" });
		const { registerMicmeExtension } = await import(pathToFileURL(join(baseline, "src/extension.ts")));
		const model = join(work, "ggml-small.en.bin");
		await writeFile(model, "placeholder for stdout-only fixture; no ASR");
		const rows = [];
		for (const [name, spec] of Object.entries(cases)) rows.push(await replayCase(registerMicmeExtension, work, model, name, spec, rows.length));
		await writeFile(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		for (const row of rows) console.log(`${row.name}: before=${JSON.stringify(row.beforeStop)} stop=${JSON.stringify(row.atStop)} replay=${JSON.stringify(row.replay)} desired=${row.meetsDesired ? "met" : "violated"}`);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

const args = new URL(import.meta.url).searchParams.get("fixture");
if (args) await fixture(...JSON.parse(args));
else if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.length === 4) {
	await evaluate(resolve(process.argv[2]), resolve(process.argv[3]));
} else {
	console.error("Usage: node test/live-native/legacy-replay.mjs LEGACY_CHECKOUT OUTPUT_JSONL");
	process.exitCode = 2;
}
