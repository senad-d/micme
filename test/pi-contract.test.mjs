import { discoverAndLoadExtensions, ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

const SUPPORTED_PI_VERSION = "1.6.0";

async function readInstalledManifest(packageName) {
	const path = join(process.cwd(), "node_modules", ...packageName.split("/"), "package.json");
	return JSON.parse(await readFile(path, "utf8"));
}

async function withEnv(values, fn) {
	const previous = new Map();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("Pi jiti contract: registers the default Micme extension", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "micme-pi-contract-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));

	const [codingAgentManifest, tuiManifest] = await Promise.all([
		readInstalledManifest("@earendil-works/pi-coding-agent"),
		readInstalledManifest("@earendil-works/pi-tui"),
	]);
	assert.equal(codingAgentManifest.name, "@earendil-works/pi-coding-agent");
	assert.equal(codingAgentManifest.version, SUPPORTED_PI_VERSION);
	assert.equal(tuiManifest.name, "@earendil-works/pi-tui");
	assert.equal(tuiManifest.version, SUPPORTED_PI_VERSION);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: agentDir,
			MICME_SHORTCUT: undefined,
			MICME_PRINTABLE_SHORTCUTS: "",
		},
		async () => {
			const entrypoint = join(process.cwd(), "src", "extension.ts");
			const result = await discoverAndLoadExtensions([entrypoint], agentDir, agentDir);

			assert.deepEqual(result.errors, []);
			assert.equal(result.extensions.length, 1);
			const extension = result.extensions[0];
			assert.ok(extension);
			assert.equal(extension.commands.has("micme"), true);
			assert.equal(extension.shortcuts.has("alt+m"), true);
			assert.equal(extension.handlers.has("session_start"), true);
			assert.equal(extension.handlers.has("session_shutdown"), true);
		},
	);
});

test("Pi jiti contract: renders a restored device panel after binding its session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-pi-device-panel-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await withEnv({ PI_CODING_AGENT_DIR: root, MICME_PRINTABLE_SHORTCUTS: "", MICME_SHORTCUT: "alt+m" }, async () => {
		const { extensions, runtime, errors } = await discoverAndLoadExtensions([join(process.cwd(), "src", "extension.ts")], root, root);
		assert.deepEqual(errors, []);
		const session = SessionManager.inMemory(root);
		const details = { sourceLabel: "Linux · Pulse", backend: "pulse", audio: [{ name: "Fixture microphone" }] };
		session.appendCustomMessageEntry("micme-devices", "Micme devices", true, details);
		const runner = new ExtensionRunner(extensions, runtime, root, session, undefined);
		runner.setUIContext({}, "tui");
		const renderer = runner.getMessageRenderer("micme-devices");
		assert.ok(renderer);
		const panel = renderer({ customType: "micme-devices", content: "Micme devices", display: true, details }, {}, {});
		await runner.emit({ type: "session_start", reason: "startup" });
		assert.match(panel.render(80).join("\n"), /Fixture microphone/);
	});
});

async function expectRows(screen, pattern) {
	let rows;
	const deadline = Date.now() + 2_000;
	do {
		rows = screen.render(100).join("\n");
		if (pattern.test(rows)) return;
		await wait(10);
	} while (Date.now() < deadline);
	assert.match(rows, pattern);
}

test("Pi jiti contract: /micme conf saves a local model using Pi's remapped selection keys", { timeout: 8_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-pi-model-picker-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const models = join(root, "models");
	const selected = join(models, "ggml-fixture-blue.bin");
	const configPath = join(root, "micme.json");
	await mkdir(models);
	await Promise.all([writeFile(selected, ""), writeFile(configPath, "{}")]);
	const previousKeybindings = getKeybindings();
	t.after(() => setKeybindings(previousKeybindings));
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+g" });
	setKeybindings(keybindings);

	await withEnv({
		PI_CODING_AGENT_DIR: root,
		PATH: join(root, "bin"),
		MICME_MODEL_DIR: models,
		MICME_WHISPER_CPP_MODEL: undefined,
		MICME_AUTO_DOWNLOAD_MODEL: "0",
		MICME_TRANSCRIPTION_MODE: "clip",
		MICME_TRANSCRIBE_BACKEND: "whisper.cpp",
	}, async () => {
		const entry = join(process.cwd(), "src", "extension.ts");
		const { extensions, runtime, errors } = await discoverAndLoadExtensions([entry], root, root);
		assert.deepEqual(errors, []);
		const runner = new ExtensionRunner(extensions, runtime, root, SessionManager.inMemory(root), undefined);
		let screen;
		const mounted = Promise.withResolvers();
		const notifications = [];
		runner.setUIContext({
			custom(factory) {
				const theme = { fg: (_color, text) => text, bold: (text) => text };
				const { promise, resolve } = Promise.withResolvers();
				screen = factory({ requestRender() {} }, theme, keybindings, resolve);
				mounted.resolve();
				return promise;
			},
			notify(message) { notifications.push(message); },
		}, "tui");
		const command = runner.getCommand("micme");
		assert.ok(command);
		const closed = command.handler("conf", runner.createCommandContext());
		try {
			await Promise.race([mounted.promise, closed]);
			assert.ok(screen, `Micme did not open its settings: ${notifications.join("; ")}`);
			await expectRows(screen, /^(?![\s\S]*Loading )/);
			for (const character of "/ASR model\r") screen.handleInput(character);
			await expectRows(screen, /→ ✓ Use default model/);
			screen.handleInput("\x0e");
			await expectRows(screen, /→ ✓ ggml-fixture-blue\.bin/);
			screen.handleInput("\r");
			assert.match(screen.render(100).join("\n"), /Select whisper\.cpp model/);
			screen.handleInput("\x07");
			await expectRows(screen, /ASR model \(Transcription\) +ggml-fixture-blue\.bin/);
			assert.equal(JSON.parse(await readFile(configPath, "utf8")).MICME_WHISPER_CPP_MODEL, selected);
		} finally {
			screen?.close();
			await closed;
		}
		assert.deepEqual(notifications, []);
	});
});
