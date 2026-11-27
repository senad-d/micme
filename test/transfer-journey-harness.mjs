import { CustomEditor, DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import micmeExtension from "../src/extension.ts";
import { MICME_TRANSFER_ACTIONS } from "../src/transfer/contracts.ts";
import { events, files, fixtures, sha } from "./transfer-journey-fixtures.mjs";

const identity = (text) => text;
const colorless = (_color, text) => text;
const theme = { fg: colorless, bg: colorless, bold: identity, strikethrough: identity, italic: identity, underline: identity, inverse: identity };
const editorTheme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const focusMark = /^\s*[→❯›>]\s*/u;
export const openAiKey = "V4_PUBLIC_FAKE_KEY_DO_NOT_RENDER";
export const prompt = "Edited prompt | ";
export const readyCue = /^(?![^\n]*\b(?:wait(?:ing)?|not yet|no verified)\b)[^\n]*\b(digital[- ]zero|(?:first|receiving|capturing|verified)\s+(?:mic(?:rophone)?\s+|audio\s+)?(?:PCM|sample)s?|samples (?:arrived|verified|received|flowing)|capturing(?:$|\s*[:—(·]))/im;

export async function until(check, why, diagnostics = () => "") {
	const deadline = performance.now() + 4_000;
	do {
		const value = await check();
		if (value) return value;
		await wait(15);
	} while (performance.now() < deadline);
	assert.fail(`${why}\n${diagnostics()}`.trimEnd());
}

function labelFor(options, pattern) {
	return options.find((option) => pattern.test(option.trim()));
}

class Dialogs {
	frames = [];
	seen = [];

	constructor(width, tui, keybindings) {
		this.width = width;
		this.tui = tui;
		this.keybindings = keybindings;
	}

	mount(info, signal) {
		const { promise, resolve } = Promise.withResolvers();
		const frame = { ...info, done: (answer) => {
			signal?.removeEventListener("abort", abort);
			const index = this.frames.indexOf(frame);
			if (index !== -1) this.frames.splice(index, 1);
			resolve(answer);
		} };
		const abort = () => frame.done(undefined);
		this.frames.push(frame);
		this.seen.push(frame);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		return { frame, promise };
	}

	custom(factory) {
		const { frame, promise } = this.mount({ kind: "custom" });
		try {
			frame.component = factory(this.tui, theme, this.keybindings, frame.done);
			return promise;
		} catch (error) {
			frame.done();
			throw error;
		}
	}

	get current() { return this.frames.at(-1); }

	text(frame = this.current) {
		return frame?.component?.render(this.width).map(stripVTControlCharacters).join("\n") ?? [frame?.title, frame?.text, ...frame?.options ?? []].filter(Boolean).join("\n");
	}

	async expect(pattern) {
		return until(() => pattern.test(this.text()) && this.text(), `dialog never showed ${pattern}`, () => this.text());
	}

	async pick(pattern) {
		// A real custom component receives keyboard events; Pi select() clients receive
		// exactly one of their own offered labels, never a manufactured return value.
		await until(() => this.current && labelFor(this.text().split("\n").map((line) => line.replace(focusMark, "")), pattern), `missing selectable action ${pattern}`, () => this.text());
		const frame = this.current;
		if (frame.kind === "select") {
			const option = labelFor(frame.options, pattern);
			assert.ok(option, `not an offered option: ${pattern}\n${this.text()}`);
			frame.done(option);
		} else {
			assert.equal(frame.kind, "custom", `no keyboard selection in ${frame.kind}`);
			for (let n = 0; n < 60; n++) {
				const focused = this.text().split("\n").find((line) => focusMark.test(line));
				if (focused && pattern.test(focused.replace(focusMark, ""))) {
					frame.component.handleInput("\r");
					return;
				}
				frame.component.handleInput("\x1b[B");
			}
			assert.fail(`could not focus ${pattern} using Down\n${this.text()}`);
		}
	}

	async answer(pattern, yes) {
		await this.expect(pattern);
		if (this.current.kind === "confirm") this.current.done(yes);
		else if (!yes) this.input("\x1b");
		else await this.pick(/^(?:yes|confirm|apply|enable|start)\b/i);
	}

	async type(pattern, text) {
		await this.expect(pattern);
		if (this.current.kind === "input" || this.current.kind === "editor") this.current.done(text);
		else this.input(`\x1b[200~${text}\x1b[201~`, "\r");
	}

	input(...keys) {
		for (const key of keys) {
			const frame = this.current;
			assert.ok(frame, `no open dialog for ${JSON.stringify(key)}`);
			if (frame.component) frame.component.handleInput(key);
			else if (key === "\x1b") frame.done(undefined);
			else assert.fail(`unexpected key ${JSON.stringify(key)} in ${frame.kind}`);
		}
	}

	dismiss() { for (const frame of [...this.frames].reverse()) frame.done(undefined); }
}

async function host(f, { width = 80, mode = "tui", busy = false } = {}) {
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
	const settingsManager = SettingsManager.inMemory();
	// Real Pi command registration/context and real Pi editor without jiti transforming
	// source URLs a second time under coverage. Existing jiti prepass stays unchanged.
	const loader = new DefaultResourceLoader({ cwd: f.project, agentDir: f.agent, settingsManager, extensionFactories: [micmeExtension],
		noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, noSkills: true });
	await loader.reload();
	const { runtime, extensions, errors } = loader.getExtensions();
	assert.deepEqual(errors, []);
	assert.equal(extensions.length, 1);
	const runner = new ExtensionRunner(extensions, runtime, f.project, SessionManager.inMemory(f.project), undefined);
	const tui = { terminal: { columns: width, rows: 32 }, requestRender() {} };
	const keybindings = getKeybindings();
	const baseEditor = new CustomEditor(tui, editorTheme, keybindings, { paddingX: 1 });
	let editor = baseEditor;
	editor.setText(prompt);
	const dialogs = new Dialogs(width, tui, keybindings);
	const notices = [];
	const statuses = [];
	const mutations = [];
	const sends = [];
	const widgets = new Map();
	const panels = [];
	let cueChannel;
	let wasReady = false;
	let rejectPaste = false;
	let closed;
	const observeCue = (channel, text) => {
		const cue = text?.match(readyCue)?.[1];
		if (cue) cueChannel ??= channel;
		if (channel !== cueChannel) return;
		// One visual state can be mirrored in two places or drawn every tick.
		// Count transitions on its first surface, and any separately published
		// explicit first-sample status even if it repeats the prior state.
		if (cue && (!wasReady || (channel === "status" && /^first\b/i.test(cue)))) {
			appendFileSync(join(f.root, "fixture.jsonl"), JSON.stringify({ kind: "readyCue", cue }) + "\n");
		}
		wasReady = Boolean(cue);
	};
	runner.onError((error) => notices.push({ level: "runner-error", message: error.error }));
	runner.bindCore({
		sendUserMessage: (text, options) => sends.push({ text, options }),
		sendMessage: (message, options) => {
			panels.push({ message, options });
			if (options?.triggerTurn || options?.deliverAs) sends.push({ message, options });
		},
		getSettings: () => settingsManager.getSettings(),
	}, { isIdle: () => !busy, hasPendingMessages: () => false, isProjectTrusted: () => true });
	runner.setUIContext({
		theme,
		notify: (message, level) => notices.push({ message, level }),
		setStatus: (_key, text) => {
			statuses.push(text);
			if (text === undefined) { cueChannel = undefined; wasReady = false; }
			else observeCue("status", text);
		},
		setWidget: (key, lines) => { widgets.set(key, lines); observeCue("widget", Array.isArray(lines) ? lines.join("\n") : undefined); },
		getEditorText: () => mode === "rpc" ? "" : editor.getExpandedText(),
		getEditorComponent: () => () => baseEditor,
		setEditorComponent: (factory) => { editor = factory(tui, theme, keybindings); },
		pasteToEditor: (text) => {
			if (rejectPaste) throw new Error("fixture editor delivery failed");
			mutations.push({ paste: text });
			// RPC's UI forwards paste as setEditorText; its prompt cannot be read back by Micme.
			if (mode === "rpc") editor.setText(text);
			else editor.handleInput(`\x1b[200~${text}\x1b[201~`);
		},
		setEditorText: (text) => { mutations.push({ set: text }); editor.setText(text); },
		custom: (factory) => dialogs.custom(factory),
		select: (title, options, opts) => dialogs.mount({ kind: "select", title, options }, opts?.signal).promise,
		confirm: (title, text, opts) => dialogs.mount({ kind: "confirm", title, text }, opts?.signal).promise,
		input: (title, text, opts) => dialogs.mount({ kind: "input", title, text }, opts?.signal).promise,
		editor: (title, text) => dialogs.mount({ kind: "editor", title, text }).promise,
	}, mode);
	const command = runner.getCommand("micme");
	assert.ok(command, "Pi did not register /micme");
	await runner.emit({ type: "session_start", reason: "startup" });
	return {
		dialogs, notices, statuses, mutations, sends, widgets,
		get text() { return editor.getExpandedText(); },
		edit: (text) => editor.setText(text),
		failEditor: () => { rejectPaste = true; },
		diagnostics: () => JSON.stringify({ notices, statuses, mutations, sends, panels, screen: dialogs.text() }),
		visible: () => [...statuses.slice(-1), ...notices.map(({ message }) => message), dialogs.text(), ...[...widgets.values()].flat()].filter(Boolean).join("\n"),
		command: (action = "") => command.handler(action, runner.createCommandContext()),
		open: async (action, pattern) => {
			let completed = false;
			const pending = command.handler(action, runner.createCommandContext()).finally(() => { completed = true; });
			// A command may either await the modal or return while it remains mounted.
			await until(() => dialogs.current || completed, `no Pi dialog opened for /micme ${action}`);
			assert.ok(dialogs.current, `/micme ${action} did not open a Pi dialog: ${notices.map(({ message }) => message).join("; ")}`);
			if (pattern) await dialogs.expect(pattern);
			return { pending };
		},
		requireAction: (action) => {
			assert.ok(MICME_TRANSFER_ACTIONS.includes(action));
			assert.ok(command.getArgumentCompletions(action)?.some(({ value }) => value === action), `/micme ${action} is not registered in Pi command completions`);
		},
		close: () => closed ??= (async () => {
			const shut = runner.emit({ type: "session_shutdown", reason: "quit" });
			dialogs.dismiss();
			await shut;
		})(),
	};
}

async function audioSnapshot(agent) {
	return Promise.all((await files(agent, ".wav")).map(async (path) => {
		const bytes = await readFile(path);
		return { path, bytes: bytes.length, digest: sha(bytes) };
	}));
}

function fixtureEnvironment(f) {
	return { PATH: f.bin, HOME: f.agent, TMPDIR: f.spool, PI_CODING_AGENT_DIR: f.agent, NO_COLOR: "1", MICME_FIXTURE_KEY: openAiKey };
}

export async function isolatedJourney(t, overrides = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme-transfer-journey-"));
	const sessions = [];
	const originalEnvironment = process.env;
	const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	t.after(async () => {
		try { await Promise.all(sessions.reverse().map((ui) => ui.close())); }
		finally {
			process.env = originalEnvironment;
			if (columns) Object.defineProperty(process.stdout, "columns", columns);
			else delete process.stdout.columns;
			await rm(root, { recursive: true, force: true });
		}
	});
	const f = await fixtures(root);
	// No personal Pi configuration, device executables, credentials or HTTP/network.
	process.env = fixtureEnvironment(f);
	const network = [];
	t.mock.method(globalThis, "fetch", (url) => { network.push(String(url)); throw new Error("unexpected network request in offline Pi journey"); });
	await Promise.all([f.configure(overrides), f.control({})]);
	return {
		...f, network,
		host: async (options) => {
			const ui = await host(f, options);
			sessions.push(ui);
			return ui;
		},
		events: (kind) => events(root, kind),
		waitEvent: (kind, n = 1, diagnostics) => until(async () => (await events(root, kind))[n - 1], `fixture did not observe ${kind} #${n}`, diagnostics),
		audio: () => audioSnapshot(f.agent),
	};
}

export function assertUntouched(ui, expected = prompt, after = 0) {
	assert.equal(ui.text, expected, "Pi editor bytes changed");
	assert.deepEqual(ui.mutations.slice(after), [], "unexpected Pi editor writes");
	assert.deepEqual(ui.sends, [], "unexpected Pi send or follow-up queue");
}

export async function take(f, ui, state = {}) {
	const n = (await f.events("trigger")).length;
	await f.control(state);
	await ui.command();
	await f.waitEvent("trigger", n + 1, ui.diagnostics);
	await ui.command();
}

export async function coldLibraryRestart(f, now) {
	const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--library-restart-probe", f.root, String(now)], { env: fixtureEnvironment(f) });
	return JSON.parse(stdout);
}

async function observeColdLibrary(root, now) {
	const f = { root, project: join(root, "project"), agent: join(root, "agent") };
	// The parent has already supplied the fixture-only environment. Set only the
	// clock here; the real product and library are freshly imported in this process.
	mock.timers.enable({ apis: ["Date"], now });
	const ui = await host(f, { width: 40 });
	try {
		const beforeListing = await audioSnapshot(f.agent);
		const { page } = await import("../src/transfer/library.ts");
		assert.equal(typeof page, "function", "L library listing is not implemented yet");
		const rows = await page(null);
		assertUntouched(ui);
		console.log(JSON.stringify({ beforeListing, rows, afterListing: await audioSnapshot(f.agent) }));
	} finally {
		await ui.close();
		mock.timers.reset();
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv[2] === "--library-restart-probe") {
	globalThis.fetch = () => { throw new Error("unexpected network request during cold library restart"); };
	await observeColdLibrary(process.argv[3], Number(process.argv[4]));
}
