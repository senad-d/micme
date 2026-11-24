import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const { registerMicmeExtension } = await import("../src/extension.ts");
const { reloadMicmeConfig } = await import("../src/config.ts");
const { MAX_CAPTURED_OUTPUT_CHARS } = await import("../src/constants.ts");
const { shellQuote } = await import("../src/processes.ts");

const theme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

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

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createExtensionHarness(cwd) {
	const commands = new Map();
	const shortcuts = new Map();
	const events = new Map();
	const uiCalls = [];
	const sentMessages = [];
	let editorFactory;
	const baseEditor = {
		focused: true,
		onSubmit: undefined,
		onChange: undefined,
		borderColor: undefined,
		render: () => ["editor"],
		invalidate() {},
		getText: () => "",
		setText() {},
		handleInput(data) {
			uiCalls.push({ method: "baseInput", value: data });
		},
	};
	const ctx = {
		cwd,
		mode: "tui",
		isIdle: () => true,
		ui: {
			theme,
			notify(message, level) {
				uiCalls.push({ method: "notify", message, level });
			},
			setStatus(key, value) {
				uiCalls.push({ method: "setStatus", key, value });
			},
			setWidget(key, value) {
				uiCalls.push({ method: "setWidget", key, value });
			},
			getEditorText: () => "",
			setEditorText(value) {
				uiCalls.push({ method: "setEditorText", value });
			},
			pasteToEditor(value) {
				uiCalls.push({ method: "pasteToEditor", value });
			},
			getEditorComponent: () => () => baseEditor,
			setEditorComponent(factory) {
				editorFactory = factory;
			},
		},
	};
	const pi = {
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options);
		},
		on(event, handler) {
			events.set(event, handler);
		},
		registerMessageRenderer() {},
		sendUserMessage(message, options) {
			sentMessages.push({ message, options });
		},
	};
	const owner = registerMicmeExtension(pi);
	return {
		commands,
		shortcuts,
		events,
		uiCalls,
		sentMessages,
		ctx,
		owner,
		hasEditorOverride() {
			return editorFactory !== undefined;
		},
		getEditor() {
			assert.ok(editorFactory);
			return editorFactory({}, theme, {});
		},
	};
}

async function emit(harness, event, details = {}) {
	const handler = harness.events.get(event);
	assert.ok(handler, `missing ${event} handler`);
	await handler(details, harness.ctx);
}

async function waitFor(predicate, message, timeoutMs = 4_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(message);
}

async function readProcessRows(path) {
	return readFile(path, "utf8")
		.then((text) => text.trim().split("\n").filter(Boolean))
		.catch(() => []);
}

async function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
	if (process.platform !== "linux") return true;
	// A terminated worker may remain as a zombie when the test runs in a container.
	const proc = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
		if (error.code === "ENOENT" || error.code === "ESRCH") return "";
		throw error;
	});
	return Boolean(proc) && !/\) Z /.test(proc);
}

function processIds(rows) {
	return rows.map((row) => Number(row.split(" ").at(-1))).filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function assertProcessesStopped(rows) {
	const pids = processIds(rows);
	await waitFor(async () => !(await Promise.all(pids.map(processIsAlive))).some(Boolean), `live Micme processes remained: ${pids.join(", ")}`);
}

async function writeExecutable(path, source) {
	await writeFile(path, source);
	await chmod(path, 0o755);
}

async function writeStreamingProcess(path) {
	await writeExecutable(
		path,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.MICME_TEST_PROCESS_LOG, \`stream \${process.pid}\\n\`);
const stop = () => setTimeout(() => process.exit(0), Number(process.env.MICME_TEST_STOP_DELAY_MS || 0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1_000);
`,
	);
}

async function writeLateFailingStreamingProcess(path) {
	await writeExecutable(
		path,
		`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
const helper = process.argv[2] === "--hold-stdout";
const gate = helper ? process.env.MICME_TEST_DRAIN_FILE : process.env.MICME_TEST_EXIT_FILE;
if (!helper) appendFileSync(process.env.MICME_TEST_PROCESS_LOG, \`stream \${process.pid}\\n\`);
const poll = setInterval(() => {
  if (!existsSync(dirname(gate))) process.exit(1);
  if (!existsSync(gate)) return;
  clearInterval(poll);
  if (helper) {
    process.stdout.write("tentative partial words\\ntentative partial words\\n");
    return;
  }
  spawn(process.execPath, [process.argv[1], "--hold-stdout"], { stdio: ["ignore", "inherit", "ignore"] }).unref();
  process.stderr.write("\\u001b[31mmicrophone disconnected\\u001b[0m\\n");
  process.exitCode = 7;
}, 10);
`,
	);
}

async function writeFfmpegProcess(path) {
	await writeExecutable(
		path,
		`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args.at(-1);
if (args.includes("volumedetect")) {
  const validationOutput = process.env.MICME_TEST_VALIDATION_OUTPUT;
  process.stderr.write(validationOutput === undefined ? "[Parsed_volumedetect_0 @ 0x1234] mean_volume: -20 dB\\n[Parsed_volumedetect_0 @ 0x1234] max_volume: -5 dB\\n" : validationOutput);
  process.exit(Number(process.env.MICME_TEST_VALIDATION_EXIT_CODE || 0));
}
if (output.endsWith("clip.wav")) {
  writeFileSync(output, Buffer.alloc(1024));
  process.exit(0);
}
writeFileSync(output, Buffer.alloc(1024));
appendFileSync(process.env.MICME_TEST_PROCESS_LOG, \`recorder \${process.pid}\\n\`);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("q")) setTimeout(() => process.exit(0), Number(process.env.MICME_TEST_STOP_DELAY_MS || 0));
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
	);
}

async function writeLateFailingFfmpegProcess(path) {
	await writeExecutable(
		path,
		`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const output = process.argv.at(-1);
writeFileSync(output, Buffer.alloc(1024));
appendFileSync(process.env.MICME_TEST_PROCESS_LOG, \`recorder \${process.pid}\\n\`);
setTimeout(() => {
  process.stderr.write("\\u001b[31mdevice failed\\u001b[0m\\n");
  process.exit(7);
}, 1_000);
`,
	);
}

async function writeTranscriberProcess(path) {
	await writeExecutable(
		path,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.MICME_TEST_PROCESS_LOG, \`transcriber \${process.pid}\\n\`);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
	);
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

function modelResponse() {
	const bytes = new TextEncoder().encode("model");
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-length": String(bytes.byteLength) } },
	);
}

test("terminal-only shortcut preserves Pi's default editor", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-extension-shortcut-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_SHORTCUT: "ctrl+space",
			MICME_PRINTABLE_SHORTCUTS: "",
		},
		async () => {
			const harness = createExtensionHarness(root);
			await emit(harness, "session_start", { reason: "startup" });

			assert.ok(harness.shortcuts.get("ctrl+space"));
			assert.equal(harness.hasEditorOverride(), false);
			await emit(harness, "session_shutdown", { reason: "quit" });
		},
	);
});

test("registered command, terminal shortcut, and printable fallback serialize delayed startup", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-start-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const stream = join(root, "whisper-stream");
	const model = join(root, "ggml-tiny.bin");
	const processLog = join(root, "processes.log");
	await writeStreamingProcess(stream);
	const response = createDeferred();
	const fetchStarted = createDeferred();

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_WHISPER_STREAM_BIN: stream,
			MICME_WHISPER_CPP_MODEL: model,
			MICME_AUTO_DOWNLOAD_MODEL: "1",
			MICME_SHORTCUT: "alt+m",
			MICME_PRINTABLE_SHORTCUTS: "§",
			MICME_STREAM_FINALIZE_WITH_CLIP: "0",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			await withMockFetch(
				async () => {
					fetchStarted.resolve();
					return response.promise;
				},
				async () => {
					const harness = createExtensionHarness(root);
					await emit(harness, "session_start", { reason: "startup" });
					const command = harness.commands.get("micme");
					const shortcut = harness.shortcuts.get("alt+m");
					assert.ok(command);
					assert.ok(shortcut);

					const commandStart = command.handler("", harness.ctx);
					await fetchStarted.promise;
					assert.equal(harness.owner.getPhase(), "starting");
					await new Promise((resolve) => setTimeout(resolve, 1_050));
					const shortcutAttempt = shortcut.handler(harness.ctx);
					harness.getEditor().handleInput("§");
					await shortcutAttempt;
					assert.equal(harness.owner.getPhase(), "starting");
					assert.equal((await readProcessRows(processLog)).length, 0);

					response.resolve(modelResponse());
					await commandStart;
					assert.equal(harness.owner.getPhase(), "streaming");
					const rows = await readProcessRows(processLog);
					assert.equal(rows.filter((row) => row.startsWith("stream ")).length, 1);
					assert.ok(harness.uiCalls.filter((entry) => entry.method === "notify" && entry.level === "warning").length >= 2);

					await emit(harness, "session_shutdown", { reason: "reload" });
					assert.equal(harness.owner.getPhase(), "shutting_down");
					await assertProcessesStopped(rows);
				},
			);
		},
	);
});

test("shutdown during model acquisition prevents stale UI and process startup", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-shutdown-start-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const stream = join(root, "whisper-stream");
	const model = join(root, "ggml-base.bin");
	const processLog = join(root, "processes.log");
	await writeStreamingProcess(stream);
	const response = createDeferred();
	const fetchStarted = createDeferred();
	let fetchSignal;

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_WHISPER_STREAM_BIN: stream,
			MICME_WHISPER_CPP_MODEL: model,
			MICME_AUTO_DOWNLOAD_MODEL: "1",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			await withMockFetch(
				async (_url, options) => {
					fetchSignal = options.signal;
					fetchStarted.resolve();
					return response.promise;
				},
				async () => {
					const harness = createExtensionHarness(root);
					const command = harness.commands.get("micme");
					assert.ok(command);
					const start = command.handler("", harness.ctx);
					await fetchStarted.promise;
					await emit(harness, "session_shutdown", { reason: "new" });
					const callsAfterShutdown = harness.uiCalls.length;

					await start;
					assert.equal(fetchSignal.aborted, true);
					assert.equal((await readProcessRows(processLog)).length, 0);
					assert.equal(harness.uiCalls.length, callsAfterShutdown);
					assert.equal(harness.sentMessages.length, 0);
					assert.deepEqual(await readdir(root), ["whisper-stream"]);
				},
			);
		},
	);
});

test("a pending default DirectShow scan yields to a UI timer and session shutdown", { skip: process.platform === "win32" && "requires POSIX fixtures" }, async (t) => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	t.after(() => Object.defineProperty(process, "platform", platform));

	for (const mode of ["clip", "stream"]) {
		await t.test(mode, async (t) => {
			const root = await mkdtemp(join(tmpdir(), "micme-extension-dshow-shutdown-"));
			t.after(() => rm(root, { recursive: true, force: true }));
			const processLog = join(root, "processes.log");
			const stream = join(root, "whisper-stream");
			const model = join(root, "ggml-tiny.bin");
			await Promise.all([
				writeStreamingProcess(stream),
				writeFile(model, "model"),
				writeExecutable(join(root, "ffmpeg.EXE"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const log = process.env.MICME_TEST_PROCESS_LOG;
if (process.argv.includes("-list_devices")) {
  appendFileSync(log, \`scan \${process.pid}\\n\`);
  process.stderr.write('"Studio Mic" (audio)\\n');
  setTimeout(() => {
    appendFileSync(log, "scan finished\\n");
    process.exit(1);
  }, 3_500);
} else {
  appendFileSync(log, \`capture \${process.pid}\\n\`);
}
`),
			]);

			await withEnv({
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
				PATHEXT: ".EXE",
				PI_CODING_AGENT_DIR: join(root, "agent"),
				MICME_RECORD_COMMAND: undefined,
				MICME_DSHOW_AUDIO_DEVICE: undefined,
				MICME_KEEP_AUDIO: "1",
				MICME_TRANSCRIPTION_MODE: mode,
				MICME_WHISPER_STREAM_BIN: stream,
				MICME_WHISPER_CPP_MODEL: model,
				MICME_STREAM_FINALIZE_WITH_CLIP: "1",
				MICME_TEST_PROCESS_LOG: processLog,
			}, async () => {
				const harness = createExtensionHarness(root);
				const start = harness.commands.get("micme").handler("", harness.ctx);
				try {
					await waitFor(async () => (await readProcessRows(processLog)).some((row) => row.startsWith("scan ")), "DirectShow fixture did not start");
					await new Promise((resolve) => setTimeout(resolve, 0));
					const [scan, ...later] = await readProcessRows(processLog);
					assert.match(scan, /^scan \d+$/);
					assert.deepEqual(later, [], "UI timer must run before the scan finishes or capture starts");
					assert.equal(harness.owner.getPhase(), "starting");

					await emit(harness, "session_shutdown", { reason: "quit" });
					const callsAfterShutdown = harness.uiCalls.length;
					await start;
					await assertProcessesStopped([scan]);
					assert.deepEqual(await readProcessRows(processLog), [scan], "shutdown must cancel the scan without starting capture");
					assert.equal(harness.owner.getPhase(), "shutting_down");
					assert.equal(harness.uiCalls.length, callsAfterShutdown);
					assert.deepEqual(await readdir(join(root, "micme-rec")), []);
				} finally {
					await emit(harness, "session_shutdown", { reason: "quit" });
					await start;
				}
			});
		});
	}
});

test("shutdown releases DirectShow scan output inherited after FFmpeg exits", { skip: process.platform === "win32" && "requires POSIX fixtures", timeout: 20_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-extension-dshow-inherited-output-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const processLog = join(root, "processes.log");
	const releaseFile = join(root, "release");
	await writeExecutable(join(root, "ffmpeg.EXE"), `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { appendFileSync, existsSync } = require("node:fs");
const log = process.env.MICME_TEST_PROCESS_LOG;
if (process.argv.includes("--hold-stderr")) {
  appendFileSync(log, \`holding stderr \${process.pid}\\n\`);
  const deadline = Date.now() + 12_000;
  const timer = setInterval(() => {
    if (!existsSync(process.env.MICME_TEST_RELEASE_FILE) && Date.now() < deadline) return;
    clearInterval(timer);
    appendFileSync(log, "released stderr\\n");
  }, 20);
} else if (process.argv.includes("-list_devices")) {
  appendFileSync(log, \`scan \${process.pid}\\n\`);
  process.stderr.write('"Partial Mic" (audio)\\n');
  spawn(process.execPath, [process.argv[1], "--hold-stderr"], { stdio: ["ignore", "ignore", "inherit"] }).unref();
  process.exitCode = 1;
} else {
  appendFileSync(log, "capture started\\n");
}
`);

	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	t.after(() => Object.defineProperty(process, "platform", platform));
	await withEnv({
		PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
		PATHEXT: ".EXE",
		PI_CODING_AGENT_DIR: join(root, "agent"),
		MICME_RECORD_COMMAND: undefined,
		MICME_DSHOW_AUDIO_DEVICE: undefined,
		MICME_TRANSCRIPTION_MODE: "clip",
		MICME_TEST_PROCESS_LOG: processLog,
		MICME_TEST_RELEASE_FILE: releaseFile,
	}, async () => {
		const harness = createExtensionHarness(root);
		let startupSettled = false;
		const start = harness.commands.get("micme").handler("", harness.ctx).finally(() => { startupSettled = true; });
		try {
			await waitFor(async () => (await readProcessRows(processLog)).some((row) => row.startsWith("holding stderr ")), "fixture did not inherit stderr");
			const rows = await readProcessRows(processLog);
			assert.match(rows.join("\n"), /^scan \d+\nholding stderr \d+$/);
			await assertProcessesStopped(rows.slice(0, 1));
			assert.equal(harness.owner.getPhase(), "starting");

			await emit(harness, "session_shutdown", { reason: "quit" });
			const callsAfterShutdown = harness.uiCalls.length;
			await waitFor(() => startupSettled, "recorder startup stayed blocked after scan cancellation", 2_000);
			assert.deepEqual(await readProcessRows(processLog), rows, "startup must settle without waiting for stderr to close or starting capture");
			assert.equal(harness.uiCalls.length, callsAfterShutdown);
		} finally {
			await writeFile(releaseFile, "");
			await emit(harness, "session_shutdown", { reason: "quit" });
			await start;
			if ((await readProcessRows(processLog)).some((row) => row.startsWith("holding stderr "))) {
				await waitFor(async () => (await readProcessRows(processLog)).includes("released stderr"), "fixture did not release inherited stderr");
			}
		}
	});
});

test("a hung DirectShow scan is terminated before clip capture starts with the default input", { skip: process.platform === "win32" && "requires POSIX fixtures", timeout: 20_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-extension-dshow-deadline-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const processLog = join(root, "processes.log");
	await writeExecutable(join(root, "ffmpeg.EXE"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const log = process.env.MICME_TEST_PROCESS_LOG;
const args = process.argv.slice(2);
if (args.includes("-list_devices")) {
  process.on("SIGTERM", () => {});
  appendFileSync(log, \`scan \${process.pid}\\n\`);
  process.stderr.write('"Partial Mic" (audio)\\n');
  // Let a regression fail without leaving the fixture running forever.
  setTimeout(() => {
    appendFileSync(log, "scan was not terminated\\n");
    process.exit(1);
  }, 12_000);
} else {
  appendFileSync(log, \`capture \${args[args.indexOf("-i") + 1]} \${process.pid}\\n\`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { if (chunk.includes("q")) process.exit(0); });
}
`);

	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	t.after(() => Object.defineProperty(process, "platform", platform));
	await withEnv({
		PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
		PATHEXT: ".EXE",
		PI_CODING_AGENT_DIR: join(root, "agent"),
		MICME_RECORD_COMMAND: undefined,
		MICME_DSHOW_AUDIO_DEVICE: undefined,
		MICME_KEEP_AUDIO: "1",
		MICME_TRANSCRIPTION_MODE: "clip",
		MICME_TEST_PROCESS_LOG: processLog,
	}, async () => {
		const harness = createExtensionHarness(root);
		try {
			await harness.commands.get("micme").handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "recording");
			await waitFor(async () => (await readProcessRows(processLog)).some((row) => row.startsWith("capture ")), "capture did not start after the scan timed out");
			const rows = await readProcessRows(processLog);
			assert.match(rows.join("\n"), /^scan \d+\ncapture audio=default \d+$/);
			await assertProcessesStopped(rows.slice(0, 1));
		} finally {
			await emit(harness, "session_shutdown", { reason: "quit" });
		}
		await assertProcessesStopped(await readProcessRows(processLog));
	});
});

test("malformed and non-object config refuse operational work before external side effects", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-extension-invalid-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const configPath = join(root, "micme.json");
	let fetchCalls = 0;

	await withEnv(
		{
			PI_CODING_AGENT_DIR: root,
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_WHISPER_STREAM_BIN: join(root, "missing-whisper-stream"),
			MICME_WHISPER_CPP_MODEL: join(root, "missing-model.bin"),
			MICME_AUTO_DOWNLOAD_MODEL: "1",
		},
		async () => {
			await writeFile(configPath, "{\u001b invalid");
			reloadMicmeConfig();
			await withMockFetch(
				async () => {
					fetchCalls += 1;
					throw new Error("fetch must not run");
				},
				async () => {
					const harness = createExtensionHarness(root);
					const command = harness.commands.get("micme");
					assert.ok(command);

					await command.handler("", harness.ctx);
					await command.handler("devices", harness.ctx);
					assert.equal(harness.owner.getPhase(), "idle");
					assert.equal(fetchCalls, 0);
					assert.equal(harness.sentMessages.length, 0);
					const malformedErrors = harness.uiCalls.filter((entry) => entry.method === "notify" && entry.level === "error");
					assert.equal(malformedErrors.length, 2);
					assert.match(malformedErrors[0]?.message ?? "", /file is not valid JSON/);
					assert.equal((malformedErrors[0]?.message ?? "").includes("\u001b"), false);

					await writeFile(configPath, "[]\n");
					reloadMicmeConfig();
					await command.handler("", harness.ctx);
					const nonObjectError = harness.uiCalls.find(
						(entry) => entry.method === "notify" && entry.level === "error" && entry.message.includes("top-level value must be a JSON object"),
					);
					assert.ok(nonObjectError);
					assert.equal(fetchCalls, 0);
				},
			);
		},
	);
});

test("shutdown owns clip recording, stopping, and transcription processes", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-clip-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ffmpeg = join(root, "ffmpeg");
	const transcriber = join(root, "whisper-cli");
	const model = join(root, "ggml-small.en.bin");
	const processLog = join(root, "processes.log");
	await Promise.all([writeFfmpegProcess(ffmpeg), writeTranscriberProcess(transcriber), writeFile(model, "model")]);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_TRANSCRIBE_BACKEND: "whisper.cpp",
			MICME_WHISPER_CPP_BIN: transcriber,
			MICME_WHISPER_CPP_MODEL: model,
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "recording", JSON.stringify(harness.uiCalls));

			const stop = command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "stopping");
			await waitFor(async () => (await readProcessRows(processLog)).some((row) => row.startsWith("transcriber ")), "transcriber did not start");
			assert.equal(harness.owner.getPhase(), "transcribing");
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "transcribing");
			assert.ok(harness.uiCalls.some((entry) => entry.method === "notify" && entry.level === "warning" && entry.message.includes("transcribing")));
			await emit(harness, "session_shutdown", { reason: "resume" });
			await stop;

			const rows = await readProcessRows(processLog);
			await assertProcessesStopped(rows);
			const callsAfterShutdown = harness.uiCalls.length;
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(harness.uiCalls.length, callsAfterShutdown);
			assert.equal(harness.sentMessages.length, 0);
		},
	);
});

test("session shutdown aborts a custom transcriber shell and its stderr-inheriting worker", { skip: process.platform === "win32", timeout: 8_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-extension-custom-shutdown-"));
	const ffmpeg = join(root, "ffmpeg");
	const worker = join(root, "worker.cjs");
	const processLog = join(root, "processes.log");
	t.after(async () => {
		for (const pid of processIds(await readProcessRows(processLog))) {
			if (await processIsAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
			}
		}
		await rm(root, { recursive: true, force: true });
	});
	await writeFfmpegProcess(ffmpeg);
	await writeFile(worker, `
const { appendFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
process.stderr.write("worker inherited stderr\\n");
appendFileSync(process.env.MICME_TEST_PROCESS_LOG, \`shell \${process.argv[2]}\\nworker \${process.pid}\\n\`);
setTimeout(() => process.exit(0), 15_000);
`);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_RECORD_COMMAND: undefined,
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_TRANSCRIBE_BACKEND: "custom",
			MICME_TRANSCRIBE_COMMAND: '"$MICME_TEST_NODE" "$MICME_TEST_WORKER" "$$" & wait',
			MICME_TRANSCRIBE_TIMEOUT_MS: "60000",
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_TEST_NODE: process.execPath,
			MICME_TEST_WORKER: worker,
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "recording");

			const operation = command.handler("", harness.ctx);
			await waitFor(async () => (await readProcessRows(processLog)).some((row) => row.startsWith("worker ")), "custom transcriber worker did not start");
			const tree = (await readProcessRows(processLog)).filter((row) => /^(shell|worker) /.test(row));
			const pids = processIds(tree);
			assert.equal(pids.length, 2);
			assert.deepEqual(await Promise.all(pids.map(processIsAlive)), [true, true]);
			assert.equal(harness.owner.getPhase(), "transcribing");

			await Promise.all([emit(harness, "session_shutdown", { reason: "quit" }), operation]);
			await assertProcessesStopped(tree);
			assert.equal(harness.owner.getPhase(), "shutting_down");
			assert.equal(harness.sentMessages.length, 0);
			assert.ok(!harness.uiCalls.some((entry) => entry.method === "pasteToEditor"));
		},
	);
});

test("shutdown directly from recording stops the recorder and widget timer", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-recording-shutdown-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ffmpeg = join(root, "ffmpeg");
	const processLog = join(root, "processes.log");
	await writeFfmpegProcess(ffmpeg);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "recording");
			await emit(harness, "session_shutdown", { reason: "quit" });

			const rows = await readProcessRows(processLog);
			await assertProcessesStopped(rows);
			const callsAfterShutdown = harness.uiCalls.length;
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(harness.uiCalls.length, callsAfterShutdown);
		},
	);
});

test("missing ffmpeg silence metrics surface a sanitized error before transcription", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-audio-validation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ffmpeg = join(root, "ffmpeg");
	const processLog = join(root, "processes.log");
	await writeFfmpegProcess(ffmpeg);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "1",
			MICME_TEST_VALIDATION_OUTPUT: "\u001b[31m[Parsed_volumedetect_0 @ 0x1234] mean_volume: -20 dB\u001b[0m\n[Parsed_volumedetect_0 @ 0x1234] max_vol",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "recording");
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "idle");

			const error = harness.uiCalls.find((entry) => entry.method === "notify" && entry.level === "error");
			assert.match(error?.message ?? "", /required max_volume metric/);
			assert.match(error?.message ?? "", /FFmpeg output:\n\[Parsed_volumedetect_0 @ 0x1234\] mean_volume: -20 dB/);
			assert.match(error?.message ?? "", /Audio kept for debugging/);
			assert.equal((error?.message ?? "").includes("\u001b"), false);
			assert.equal(harness.uiCalls.some((entry) => entry.method === "pasteToEditor"), false);
			assert.equal(harness.sentMessages.length, 0);
		},
	);
});

test("a nonregular clip transcript reports an error instead of pasting hook stdout", { skip: process.platform === "win32" && "requires POSIX device and recorder fixtures" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-extension-nonregular-transcript-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const processLog = join(root, "processes.log");
	await writeFfmpegProcess(join(root, "ffmpeg"));

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_RECORD_COMMAND: undefined,
			MICME_TEST_PROCESS_LOG: processLog,
			MICME_TRANSCRIBE_BACKEND: "custom",
			// A device gives immediate EOF even if the regular-file check is missing.
			MICME_TRANSCRIBE_COMMAND: "ln -s /dev/null {transcript} && printf 'fallback transcript'",
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_AUTO_SUBMIT: "0",
			MICME_KEEP_AUDIO: "1",
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			try {
				await command.handler("", harness.ctx);
				assert.equal(harness.owner.getPhase(), "recording");
				await waitFor(async () => (await readProcessRows(processLog)).length > 0, "recorder did not start");
				await command.handler("", harness.ctx);

				assert.equal(harness.owner.getPhase(), "idle");
				assert.deepEqual(harness.uiCalls.filter((entry) => entry.method === "pasteToEditor" || entry.method === "setEditorText"), []);
				assert.equal(harness.sentMessages.length, 0);
				const error = harness.uiCalls.find((entry) => entry.method === "notify" && entry.level === "error");
				assert.match(error?.message ?? "", /Transcript output is not a regular file/);
			} finally {
				await emit(harness, "session_shutdown", { reason: "quit" });
			}
		},
	);
});

test("clip auto-submit strips a C1 terminal string from the transcriber's file", { skip: process.platform === "win32" && "requires POSIX recorder and transcriber fixtures" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-extension-c1-transcript-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const processLog = join(root, "processes.log");
	await writeFfmpegProcess(join(root, "ffmpeg"));
	const transcript = "left\u009Dformatting\u009Cright";

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_RECORD_COMMAND: undefined,
			MICME_TEST_PROCESS_LOG: processLog,
			MICME_TRANSCRIBE_BACKEND: "custom",
			MICME_TRANSCRIBE_COMMAND: `printf '%s' ${shellQuote(transcript)} > {transcript}`,
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_AUTO_SUBMIT: "1",
			MICME_KEEP_AUDIO: "0",
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			try {
				await command.handler("", harness.ctx);
				assert.equal(harness.owner.getPhase(), "recording");
				await waitFor(async () => (await readProcessRows(processLog)).length > 0, "recorder did not start");
				await command.handler("", harness.ctx);

				assert.equal(harness.owner.getPhase(), "idle");
				assert.deepEqual(harness.sentMessages, [{ message: "left right", options: undefined }]);
				assert.equal(harness.uiCalls.some((entry) => entry.method === "pasteToEditor"), false);
			} finally {
				await emit(harness, "session_shutdown", { reason: "quit" });
			}
		},
	);
});

test("stopping a custom clip recorder that exits 255 pastes its transcript", { skip: process.platform === "win32" && "requires POSIX SIGINT handling" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-extension-custom-signal-stop-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const recorder = join(root, "recorder.mjs");
	const ready = join(root, "ready");
	await writeFile(
		recorder,
		`import { writeFileSync } from "node:fs";
const [audio, ready] = process.argv.slice(2);
process.on("SIGINT", () => {
  // Mono 16-bit PCM WAV header followed by 1024 bytes of samples.
  const header = Buffer.from("524946462404000057415645666d74201000000001000100803e0000007d0000020010006461746100040000", "hex");
  writeFileSync(audio, Buffer.concat([header, Buffer.alloc(1024, 32)]));
  process.exit(255);
});
writeFileSync(ready, "ready");
setInterval(() => {}, 1_000);
`,
	);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_RECORD_COMMAND: `exec ${shellQuote(process.execPath)} ${shellQuote(recorder)} {audio} ${shellQuote(ready)}`,
			MICME_TRANSCRIBE_BACKEND: "custom",
			MICME_TRANSCRIBE_COMMAND: "test -s {audio} && printf 'custom stop transcript'",
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_AUTO_SUBMIT: "0",
			MICME_KEEP_AUDIO: "1",
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			try {
				await command.handler("", harness.ctx);
				assert.equal(harness.owner.getPhase(), "recording", JSON.stringify(harness.uiCalls));
				await waitFor(async () => (await readProcessRows(ready)).length > 0, "custom recorder did not install its SIGINT handler");
				await command.handler("", harness.ctx);
				assert.equal(harness.owner.getPhase(), "idle");
				assert.deepEqual(harness.uiCalls.filter((entry) => entry.method === "notify" && entry.level === "error"), []);
				assert.deepEqual(harness.uiCalls.filter((entry) => entry.method === "pasteToEditor"), [{ method: "pasteToEditor", value: "custom stop transcript " }]);
				assert.equal(harness.sentMessages.length, 0);
			} finally {
				await emit(harness, "session_shutdown", { reason: "quit" });
			}
		},
	);
});

for (const autoSubmit of [false, true]) {
	test(`truncated clip stdout is not delivered in ${autoSubmit ? "auto-submit" : "paste-for-review"} mode`, { skip: process.platform === "win32" && "requires POSIX executable fixtures" }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "micme-extension-truncated-transcript-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const processLog = join(root, "processes.log");
		await writeFfmpegProcess(join(root, "ffmpeg"));

		await withEnv(
			{
				PI_CODING_AGENT_DIR: join(root, "agent"),
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
				MICME_TEST_PROCESS_LOG: processLog,
				MICME_RECORD_COMMAND: undefined,
				MICME_TRANSCRIPTION_MODE: "clip",
				MICME_TRANSCRIBE_BACKEND: "custom",
				MICME_TRANSCRIBE_COMMAND: `${shellQuote(process.execPath)} -e "process.stdout.write('a' + 'x'.repeat(${MAX_CAPTURED_OUTPUT_CHARS}))"`,
				MICME_PROCESS_AUDIO: "0",
				MICME_VALIDATE_AUDIO: "0",
				MICME_AUTO_SUBMIT: autoSubmit ? "1" : "0",
				MICME_KEEP_AUDIO: "1",
			},
			async () => {
				const harness = createExtensionHarness(root);
				const command = harness.commands.get("micme");
				assert.ok(command);
				try {
					await command.handler("", harness.ctx);
					assert.equal(harness.owner.getPhase(), "recording", JSON.stringify(harness.uiCalls));
					await waitFor(async () => (await readProcessRows(processLog)).some((row) => row.startsWith("recorder ")), "clip recorder did not start");
					await command.handler("", harness.ctx);
					assert.equal(harness.owner.getPhase(), "idle");

					assert.equal(harness.uiCalls.some((entry) => entry.method === "pasteToEditor" || entry.method === "setEditorText"), false, "truncated transcript reached the editor");
					assert.equal(harness.sentMessages.length, 0, "truncated transcript was submitted");
					const error = harness.uiCalls.find((entry) => entry.method === "notify" && entry.level === "error");
					assert.match(error?.message ?? "", /stdout.*capture limit.*truncated/i);
				} finally {
					await emit(harness, "session_shutdown", { reason: "quit" });
				}
			},
		);
	});
}

test("missing ffmpeg explicitly warns custom-recorder users when validation is skipped", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-validation-skip-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	await mkdir(bin);
	await symlink("/bin/sh", join(bin, "sh"));
	await writeExecutable(
		join(bin, "recorder"),
		`#!/bin/sh
output="$1"
i=0
: > "$output"
while [ "$i" -lt 600 ]; do
  printf x >> "$output"
  i=$((i + 1))
done
trap 'exit 0' INT TERM
while :; do /bin/sleep 1; done
`,
	);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: bin,
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_RECORD_COMMAND: `exec '${join(bin, "recorder")}' {audio}`,
			MICME_TRANSCRIBE_BACKEND: "custom",
			MICME_TRANSCRIBE_COMMAND: "printf 'custom transcript'",
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "1",
			MICME_SKIP_AUDIO_VALIDATION: "0",
			MICME_AUTO_SUBMIT: "0",
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "recording", JSON.stringify(harness.uiCalls));
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "idle");

			const warning = harness.uiCalls.find((entry) => entry.method === "notify" && entry.level === "warning");
			assert.match(warning?.message ?? "", /skipped silence validation because ffmpeg was not found/);
			assert.ok(harness.uiCalls.some((entry) => entry.method === "pasteToEditor" && entry.value === "custom transcript "));
		},
	);
});

test("shutdown while streaming is stopping prevents finalization work", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-stopping-shutdown-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const stream = join(root, "whisper-stream");
	const model = join(root, "ggml-small.en.bin");
	const processLog = join(root, "processes.log");
	await Promise.all([writeStreamingProcess(stream), writeFile(model, "model")]);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_WHISPER_STREAM_BIN: stream,
			MICME_WHISPER_CPP_MODEL: model,
			MICME_STREAM_FINALIZE_WITH_CLIP: "0",
			MICME_TEST_STOP_DELAY_MS: "200",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			const stop = command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "stopping");
			await emit(harness, "session_shutdown", { reason: "reload" });
			await stop;

			const rows = await readProcessRows(processLog);
			await assertProcessesStopped(rows);
			assert.equal(harness.sentMessages.length, 0);
		},
	);
});

function assertAutomaticStopUi(harness) {
	assert.equal(harness.owner.getPhase(), "idle");
	const errors = harness.uiCalls.filter((entry) => entry.method === "notify" && entry.level === "error");
	assert.equal(errors.length, 1);
	const widgetCalls = harness.uiCalls.filter((entry) => entry.method === "setWidget");
	assert.ok(widgetCalls.some((entry) => Array.isArray(entry.value)), "recording widget was never shown");
	assert.equal(widgetCalls.at(-1)?.value, undefined);
	const statusCalls = harness.uiCalls.filter((entry) => entry.method === "setStatus");
	assert.equal(statusCalls.filter((entry) => entry.value === "stopping…").length, 1);
	assert.equal(statusCalls.at(-1)?.value, undefined);
	assert.equal(harness.sentMessages.length, 0);
	assert.equal(harness.uiCalls.some((entry) => entry.method === "pasteToEditor" || entry.method === "setEditorText"), false, "partial transcript reached the editor");
	return errors[0].message;
}

async function withExitedClipRecorder(t, verifyStop) {
	if (process.platform === "win32") {
		t.skip("POSIX inherited pipe fixture is not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-recorder-drain-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const recorder = join(root, "recorder.mjs");
	const transcribed = join(root, "transcribed");
	await writeFile(
		recorder,
		`import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [target, root] = process.argv.slice(2);
const helper = target === "--hold-stderr";
if (!helper) {
  // Mono 16-bit PCM WAV header followed by 1024 bytes of samples.
  const header = Buffer.from("524946462404000057415645666d74201000000001000100803e0000007d0000020010006461746100040000", "hex");
  writeFileSync(target, Buffer.concat([header, Buffer.alloc(1024, 32)]));
  spawn(process.execPath, [process.argv[1], "--hold-stderr", root], { stdio: ["ignore", "ignore", "inherit"] }).unref();
  writeFileSync(join(root, "recorder.pid"), String(process.pid));
}
const gate = join(root, helper ? "drain" : "exit");
const poll = setInterval(() => {
  if (!existsSync(root)) process.exit(1);
  if (!existsSync(gate)) return;
  clearInterval(poll);
  if (helper) process.stderr.write("delayed recorder diagnostic\\n");
}, 10);
`,
	);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_TRANSCRIPTION_MODE: "clip",
			MICME_RECORD_COMMAND: `exec '${process.execPath}' '${recorder}' {audio} '${root}'`,
			MICME_TRANSCRIBE_BACKEND: "custom",
			MICME_TRANSCRIBE_COMMAND: `printf 'partial transcript' > '${transcribed}'; printf 'partial transcript'`,
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_AUTO_SUBMIT: "0",
			MICME_KEEP_AUDIO: "1",
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			const drain = join(root, "drain");
			try {
				await command.handler("", harness.ctx);
				assert.equal(harness.owner.getPhase(), "recording", JSON.stringify(harness.uiCalls));
				const pidFile = join(root, "recorder.pid");
				await waitFor(async () => (await readProcessRows(pidFile)).length > 0, "recorder PID was not logged");
				const pid = Number(await readFile(pidFile, "utf8"));
				assert.ok(Number.isInteger(pid) && pid > 0);
				await writeFile(join(root, "exit"), "");
				await verifyStop({ harness, drain });
				assert.equal(await processIsAlive(pid), false);
				await assert.rejects(readFile(transcribed), { code: "ENOENT" }, "partial audio was transcribed");
			} finally {
				await writeFile(drain, "");
				await emit(harness, "session_shutdown");
			}
		},
	);
}

test("a late clip exit stops automatically before stderr drains, then reports its diagnostic", async (t) => {
	await withExitedClipRecorder(t, async ({ harness, drain }) => {
		await waitFor(() => harness.owner.getPhase() === "stopping", "late clip exit did not start stopping", 2_000);
		const widget = harness.uiCalls.findLast((entry) => entry.method === "setWidget");
		assert.equal(widget?.value, undefined);
		await writeFile(drain, "");
		await waitFor(() => harness.owner.getPhase() === "idle", "late clip exit did not return to idle");
		const error = assertAutomaticStopUi(harness);
		assert.match(error, /recorder exited unexpectedly \(code 0\)/);
		assert.match(error, /Recorder output:\ndelayed recorder diagnostic/);
	});
});

test("a late clip exit returns to idle even if stderr stays open", async (t) => {
	await withExitedClipRecorder(t, async ({ harness }) => {
		await waitFor(() => harness.owner.getPhase() === "idle", "Micme remained stuck while the exited recorder's stderr was held open", 6_000);
		assert.match(assertAutomaticStopUi(harness), /recorder exited unexpectedly \(code 0\)/);
	});
});

test("a late stream exit stops automatically and shuts down its final-clip recorder", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-stream-exit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ffmpeg = join(root, "ffmpeg");
	const stream = join(root, "whisper-stream");
	const transcriber = join(root, "whisper-cli");
	const model = join(root, "ggml-small.en.bin");
	const processLog = join(root, "processes.log");
	const exitFile = join(root, "exit");
	const drainFile = join(root, "drain");
	await Promise.all([writeFfmpegProcess(ffmpeg), writeLateFailingStreamingProcess(stream), writeTranscriberProcess(transcriber), writeFile(model, "model")]);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_TRANSCRIBE_BACKEND: "whisper.cpp",
			MICME_WHISPER_STREAM_BIN: stream,
			MICME_WHISPER_CPP_BIN: transcriber,
			MICME_WHISPER_CPP_MODEL: model,
			MICME_STREAM_FINALIZE_WITH_CLIP: "1",
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_AUTO_SUBMIT: "1",
			MICME_KEEP_AUDIO: "1",
			MICME_TEST_PROCESS_LOG: processLog,
			MICME_TEST_EXIT_FILE: exitFile,
			MICME_TEST_DRAIN_FILE: drainFile,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			try {
				await command.handler("", harness.ctx);
				assert.equal(harness.owner.getPhase(), "streaming");
				await waitFor(async () => {
					const rows = await readProcessRows(processLog);
					return rows.some((row) => row.startsWith("recorder ")) && rows.some((row) => row.startsWith("stream "));
				}, "stream and companion recorder PIDs were not logged");
				const started = await readProcessRows(processLog);
				assert.deepEqual(started.map((row) => row.split(" ")[0]).sort(), ["recorder", "stream"]);
				assert.deepEqual(await Promise.all(processIds(started).map(processIsAlive)), [true, true]);
				await writeFile(exitFile, "");
				await waitFor(() => harness.owner.getPhase() === "stopping", "late stream exit did not start stopping", 2_000);
				await writeFile(drainFile, "");
				await waitFor(() => harness.owner.getPhase() === "idle", "late stream exit did not return to idle");
				const error = assertAutomaticStopUi(harness);
				assert.match(error, /stream exited unexpectedly \(code 7\)/);
				assert.match(error, /Stream output:\nmicrophone disconnected/);
				assert.equal(error.includes("\u001b"), false);
				assert.deepEqual(await readProcessRows(processLog), started, "partial audio started transcription");
				await assertProcessesStopped(started);
			} finally {
				await writeFile(drainFile, "");
				await emit(harness, "session_shutdown");
			}
		},
	);
});

test("late optional final-clip failure keeps the live-stream fallback without transcribing partial audio", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-final-clip-exit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ffmpeg = join(root, "ffmpeg");
	const stream = join(root, "whisper-stream");
	const model = join(root, "ggml-small.en.bin");
	const processLog = join(root, "processes.log");
	await Promise.all([writeLateFailingFfmpegProcess(ffmpeg), writeStreamingProcess(stream), writeFile(model, "model")]);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_WHISPER_STREAM_BIN: stream,
			MICME_WHISPER_CPP_MODEL: model,
			MICME_STREAM_FINALIZE_WITH_CLIP: "1",
			MICME_AUTO_SUBMIT: "0",
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "streaming", JSON.stringify(harness.uiCalls));
			const startedRows = await readProcessRows(processLog);
			const recorderPid = Number(startedRows.find((row) => row.startsWith("recorder "))?.split(" ").at(-1));
			assert.equal(Number.isFinite(recorderPid), true);
			await waitFor(async () => !(await processIsAlive(recorderPid)), "late-failing optional recorder remained alive");

			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "idle");
			const rows = await readProcessRows(processLog);
			await assertProcessesStopped(rows);
			assert.equal(rows.some((row) => row.startsWith("transcriber ")), false);
			const warning = harness.uiCalls.find(
				(entry) => entry.method === "notify" && entry.level === "warning" && entry.message.includes("final clip transcription failed"),
			);
			assert.match(warning?.message ?? "", /recorder exited unexpectedly \(code 7\)/);
			assert.match(warning?.message ?? "", /Recorder output:\ndevice failed/);
			assert.equal(harness.uiCalls.filter((entry) => entry.method === "setStatus" && entry.value === "stopping…").length, 1);
			assert.equal(harness.uiCalls.some((entry) => entry.method === "notify" && entry.level === "error"), false);
			assert.equal(harness.sentMessages.length, 0);
		},
	);
});

test("shutdown during stream finalization stops the clip transcriber and all recorders", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-finalize-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ffmpeg = join(root, "ffmpeg");
	const stream = join(root, "whisper-stream");
	const transcriber = join(root, "whisper-cli");
	const model = join(root, "ggml-small.en.bin");
	const processLog = join(root, "processes.log");
	await Promise.all([writeFfmpegProcess(ffmpeg), writeStreamingProcess(stream), writeTranscriberProcess(transcriber), writeFile(model, "model")]);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_TRANSCRIBE_BACKEND: "whisper.cpp",
			MICME_WHISPER_STREAM_BIN: stream,
			MICME_WHISPER_CPP_BIN: transcriber,
			MICME_WHISPER_CPP_MODEL: model,
			MICME_STREAM_FINALIZE_WITH_CLIP: "1",
			MICME_PROCESS_AUDIO: "0",
			MICME_VALIDATE_AUDIO: "0",
			MICME_TEST_STOP_DELAY_MS: "50",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "streaming", JSON.stringify(harness.uiCalls));

			const stop = command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "stopping");
			await waitFor(async () => (await readProcessRows(processLog)).some((row) => row.startsWith("transcriber ")), "final clip transcriber did not start");
			assert.equal(harness.owner.getPhase(), "finalizing");
			await emit(harness, "session_shutdown", { reason: "fork" });
			await stop;

			const rows = await readProcessRows(processLog);
			assert.equal(rows.filter((row) => row.startsWith("stream ")).length, 1);
			assert.equal(rows.filter((row) => row.startsWith("recorder ")).length, 1);
			assert.equal(rows.filter((row) => row.startsWith("transcriber ")).length, 1);
			await assertProcessesStopped(rows);
			assert.equal(harness.sentMessages.length, 0);
		},
	);
});
