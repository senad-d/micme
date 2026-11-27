import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const sourceRoot = new URL("../src/", import.meta.url).href;
const piPackage = "@earendil-works/pi-coding-agent";
const piModuleUrl = import.meta.resolve(piPackage);
const ompMarker = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(piModuleUrl)}; export const CONFIG_DIR_NAME = ".omp";`)}`;
const unusedWidth = "data:text/javascript,export const sliceCells=0,truncate=text=>text,visibleWidth=0,wrap=0";
const ompContractSources = /\/node_modules\/@oh-my-pi\/(pi-coding-agent\/src\/(config\/keybindings\/(app-keybindings|tui-keybindings|key-id)|utils\/fuzzy)|pi-tui\/src\/driver\/input\/keys)\.ts$/;

function resolveOmpContract(specifier, context, nextResolve) {
	if (specifier === piPackage && context.parentURL?.startsWith(sourceRoot)) {
		return nextResolve(ompMarker, context);
	}
	// The shortcut tests do not render UI; avoid loading OMP's Bun-only width dependencies.
	if (specifier === "@oh-my-pi/pi-tui/text/width") return nextResolve(unusedWidth, context);
	// OMP ships these stock key definitions as Bun TypeScript with extensionless imports.
	if (specifier === "./tui-keybindings" && context.parentURL?.endsWith("/app-keybindings.ts")) {
		return nextResolve("./tui-keybindings.ts", context);
	}
	return nextResolve(specifier, context);
}

function loadOmpContract(url, context, nextLoad) {
	if (!ompContractSources.test(url)) {
		return nextLoad(url, context);
	}
	const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext } });
	return { format: "module", source: outputText, shortCircuit: true };
}

function isolateMicmeConfig(t, root) {
	const keys = new Set(["PI_CODING_AGENT_DIR", "MICME_SHORTCUT", ...Object.keys(process.env).filter((name) => name.startsWith("MICME_"))]);
	const previous = [...keys].map((name) => [name, process.env[name]]);
	for (const name of keys) delete process.env[name];
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

function stockBindingFor(keybindings, chord) {
	return Object.entries(keybindings).find(([action, { defaultKeys }]) =>
		/^(app\.|tui\.(editor|input)\.)/.test(action) && [defaultKeys].flat().includes(chord),
	)?.[0];
}

async function loadOmpExtension(t, configure) {
	const root = await mkdtemp(join(tmpdir(), "micme-omp-shortcut-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	isolateMicmeConfig(t, root);
	await configure?.(root);
	const hook = registerHooks({ resolve: resolveOmpContract, load: loadOmpContract });
	t.after(() => hook.deregister());

	const { registerMicmeExtension } = await import("../src/extension.ts");
	const commands = new Map();
	const shortcuts = new Map();
	const owner = registerMicmeExtension({
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut.handler),
		registerMessageRenderer() {},
		on() {},
	});
	return { commands, shortcuts, owner, root };
}

test("/micme help advertises a recording shortcut that OMP's stock editor does not already use", async (t) => {
	const { commands, shortcuts } = await loadOmpExtension(t);
	const { KEYBINDINGS } = await import("@oh-my-pi/pi-coding-agent/config/keybindings/app-keybindings");
	const messages = [];
	await commands.get("micme").handler("help", { ui: { notify: (text) => messages.push(text) } });
	const chord = messages[0]?.match(/Shortcut: (.+?) toggles recording/)?.[1];
	assert.ok(shortcuts.has(chord), "/micme help must advertise the registered recording shortcut");
	const competingAction = stockBindingFor(KEYBINDINGS, chord);
	assert.equal(competingAction, undefined, `${chord} is already bound to ${competingAction} in OMP`);
});

function captureTerminalInput() {
	const listeners = new Set();
	return {
		listen(handler) {
			listeners.add(handler);
			return () => { assert.ok(listeners.delete(handler), "unsubscribe removes only its own listener"); };
		},
		send(raw) {
			for (const listener of listeners) assert.equal(listener(raw), undefined);
		},
		get size() { return listeners.size; },
	};
}

async function startShortcutDispatch(t, shortcut) {
	const { owner, shortcuts } = await loadOmpExtension(t, () => {
		if (shortcut) process.env.MICME_SHORTCUT = shortcut;
	});
	const { decodeTerminalKey } = await import("../src/terminal-ui-omp.ts");
	const toggle = t.mock.method(owner, "toggle", async () => {});
	const terminal = captureTerminalInput();
	const ctx = {
		mode: "tui",
		sessionManager: { getEntries: () => [] },
		ui: {
			onTerminalInput: terminal.listen,
			setStatus() {},
			setWidget() {},
		},
	};
	await owner.startSession(ctx);
	t.mock.timers.enable({ apis: ["Date"], now: 2_000 });
	return {
		async send(raw) {
			terminal.send(raw);
			const key = decodeTerminalKey(raw);
			if (key && key.kind !== "release") await shortcuts.get(key.id)?.(ctx);
		},
		async shutdown() {
			await owner.shutdown(ctx);
			assert.equal(terminal.size, 0);
		},
		toggleCount: () => toggle.mock.callCount(),
	};
}

test("OMP's registered F8 toggles again after its release, without reacting to a held key", async (t) => {
	const { send, shutdown, toggleCount } = await startShortcutDispatch(t);
	const f8 = "\x1b[19~";
	await send(f8);
	await send("\x1b[20;1:3~"); // F9 release must not rearm F8.
	t.mock.timers.tick(850);
	await send(f8); // Legacy duplicate or second tap without a release.
	assert.equal(toggleCount(), 1);
	await send("\x1b[19;1:3~");
	await send(f8);
	assert.equal(toggleCount(), 2);
	t.mock.timers.tick(1_100);
	await send("\x1b[19;1:2~"); // OMP dispatches even late explicit repeats to registered handlers.
	assert.equal(toggleCount(), 2);
	t.mock.timers.tick(1_100);
	await send(f8); // Legacy terminals still recognize a new tap after the guard interval.
	assert.equal(toggleCount(), 3);
	await shutdown();
});

test("OMP's registered Ctrl+F8 rearms when Ctrl is lifted before F8", async (t) => {
	const { send, shutdown, toggleCount } = await startShortcutDispatch(t, "ctrl+f8");
	const press = "\x1b[19;5:1~";
	await send(press);
	t.mock.timers.tick(850);
	await send("\x1b[20;1:3~"); // Unrelated F9 release.
	await send(press);
	assert.equal(toggleCount(), 1);
	await send("\x1b[19;1:3~"); // Ctrl was lifted first, so the release is reported as F8 only.
	await send("\x1b[19;1:1~"); // The base key by itself must not activate the shortcut.
	assert.equal(toggleCount(), 1);
	await send(press);
	assert.equal(toggleCount(), 2);
	await shutdown();
});

async function configureClipRecorder(root, shortcut) {
	const recorder = join(root, "recorder.mjs");
	const { shellQuote } = await import("../src/processes.ts");
	const wave = Buffer.alloc(1024);
	wave.write("RIFF");
	wave.writeUInt32LE(wave.length - 8, 4);
	wave.write("WAVEfmt ", 8);
	wave.writeUInt32LE(16, 16);
	wave.writeUInt16LE(1, 20);
	wave.writeUInt16LE(1, 22);
	wave.writeUInt32LE(16_000, 24);
	wave.writeUInt32LE(32_000, 28);
	wave.writeUInt16LE(2, 32);
	wave.writeUInt16LE(16, 34);
	wave.write("data", 36);
	wave.writeUInt32LE(wave.length - 44, 40);
	await writeFile(recorder, `import { writeFileSync } from "node:fs";
process.on("SIGINT", () => process.exit(0));
writeFileSync(process.argv[2], Buffer.from(${JSON.stringify(wave.toString("base64"))}, "base64"));
setInterval(() => {}, 1000);
`);
	await writeFile(join(root, "micme.json"), JSON.stringify({
		MICME_SHORTCUT: shortcut,
		// Reproduce macOS's F8 + § default on every host, without changing process.platform.
		MICME_PRINTABLE_SHORTCUTS: shortcut === undefined ? "§" : undefined,
		MICME_TRANSCRIPTION_MODE: "clip",
		MICME_RECORD_COMMAND: `exec ${shellQuote(process.execPath)} ${shellQuote(recorder)} {audio}`,
		MICME_TRANSCRIBE_BACKEND: "custom",
		MICME_TRANSCRIBE_COMMAND: "printf 'Two separate taps.'",
		MICME_PROCESS_AUDIO: "0",
		MICME_VALIDATE_AUDIO: "0",
		MICME_KEEP_AUDIO: "0",
		MICME_AUTO_SUBMIT: "0",
	}));
}

async function checkClipShortcut(t, printable) {
	const { owner, root, shortcuts } = await loadOmpExtension(t, (dir) => configureClipRecorder(dir, printable ? "§" : undefined));
	const { decodeTerminalKey } = await import("../src/terminal-ui-omp.ts");
	const press = printable ? "\x1b[51:167;2:1;167u" : "\x1b[19~";
	const release = printable ? "\x1b[51;1:3u" : "\x1b[19;1:3~";
	const recording = Promise.withResolvers();
	const finished = Promise.withResolvers();
	const notifications = [];
	const terminal = captureTerminalInput();
	let transcript;
	let status;
	let composer;
	const ctx = {
		cwd: root,
		mode: "tui",
		sessionManager: { getEntries: () => [] },
		ui: {
			composer: { addKeyHandler(handler) { composer = handler; return () => { composer = undefined; }; } },
			onTerminalInput: terminal.listen,
			notify(message) { notifications.push(message); },
			setStatus(_key, value) {
				status = value;
				if (value?.startsWith("● recording")) recording.resolve(value);
				else if (value === undefined) {
					recording.resolve(value);
					finished.resolve();
				}
			},
			setWidget() {},
			theme: { fg: (_color, text) => text },
			pasteToEditor(text) { transcript = text; },
		},
	};
	const tap = () => {
		terminal.send(press);
		if (printable) assert.equal(composer(decodeTerminalKey(press)), true);
		else void shortcuts.get("f8")(ctx);
	};
	try {
		await owner.startSession(ctx);
		assert.equal(typeof composer, "function");
		assert.equal(terminal.size, printable ? 1 : 2, "F8 and the printable fallback each observe terminal input");
		t.mock.timers.enable({ apis: ["Date"], now: 2_000 });
		tap();
		assert.match(await recording.promise ?? "", /^● recording /, notifications.join("; "));
		// OMP gives releases only to the raw listeners. For §, Shift was lifted before the base key.
		terminal.send(release);
		t.mock.timers.tick(850);
		tap();
		assert.equal(status, "stopping…", "the second press must stop the ready recording before the repeat guard expires");
		await finished.promise;
		assert.equal(transcript, "Two separate taps. ", notifications.join("; "));
	} finally {
		await owner.shutdown(ctx);
		assert.equal(terminal.size, 0);
		assert.equal(composer, undefined);
	}
}

const clipTestOptions = { skip: process.platform === "win32", timeout: 8_000 };
test("OMP shifted printable double tap stops recording and pastes the transcript", clipTestOptions, (t) => checkClipShortcut(t, true));
test("OMP default F8 double tap stops recording and pastes the transcript", clipTestOptions, (t) => checkClipShortcut(t, false));
