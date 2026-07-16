import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const { registerMicmeExtension } = await import("../src/extension.ts");
const { reloadMicmeConfig } = await import("../src/config.ts");

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

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function assertProcessesStopped(rows) {
	const pids = rows.map((row) => Number(row.split(" ").at(-1))).filter(Number.isFinite);
	await waitFor(() => pids.every((pid) => !processIsAlive(pid)), `live Micme processes remained: ${pids.join(", ")}`);
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
import { appendFileSync } from "node:fs";
appendFileSync(process.env.MICME_TEST_PROCESS_LOG, \`stream \${process.pid}\\n\`);
setTimeout(() => {
  process.stderr.write("\\u001b[31mmicrophone disconnected\\u001b[0m\\n");
  process.exit(7);
}, 1_000);
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
  process.stderr.write(validationOutput === undefined ? "mean_volume: -20 dB\\nmax_volume: -5 dB\\n" : validationOutput);
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
			MICME_TEST_VALIDATION_OUTPUT: "\u001b[31mmean_volume: -20 dB\u001b[0m\nmax_vol",
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
			assert.match(error?.message ?? "", /FFmpeg output:\nmean_volume: -20 dB/);
			assert.match(error?.message ?? "", /Audio kept for debugging/);
			assert.equal((error?.message ?? "").includes("\u001b"), false);
			assert.equal(harness.uiCalls.some((entry) => entry.method === "pasteToEditor"), false);
			assert.equal(harness.sentMessages.length, 0);
		},
	);
});

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

test("late stream exit is reported instead of completing as an empty dictation", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable fixtures are not portable to Windows");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "micme-extension-stream-exit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const stream = join(root, "whisper-stream");
	const model = join(root, "ggml-small.en.bin");
	const processLog = join(root, "processes.log");
	await Promise.all([writeLateFailingStreamingProcess(stream), writeFile(model, "model")]);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_WHISPER_STREAM_BIN: stream,
			MICME_WHISPER_CPP_MODEL: model,
			MICME_STREAM_FINALIZE_WITH_CLIP: "0",
			MICME_TEST_PROCESS_LOG: processLog,
		},
		async () => {
			const harness = createExtensionHarness(root);
			const command = harness.commands.get("micme");
			assert.ok(command);
			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "streaming");
			const rows = await readProcessRows(processLog);
			const streamPid = Number(rows.find((row) => row.startsWith("stream "))?.split(" ").at(-1));
			assert.equal(Number.isFinite(streamPid), true);
			await waitFor(() => !processIsAlive(streamPid), "late-failing stream remained alive");

			await command.handler("", harness.ctx);
			assert.equal(harness.owner.getPhase(), "idle");
			const error = harness.uiCalls.find((entry) => entry.method === "notify" && entry.level === "error");
			assert.match(error?.message ?? "", /stream exited unexpectedly \(code 7\)/);
			assert.match(error?.message ?? "", /Stream output:\nmicrophone disconnected/);
			assert.equal((error?.message ?? "").includes("\u001b"), false);
			assert.equal(harness.sentMessages.length, 0);
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
			await waitFor(() => !processIsAlive(recorderPid), "late-failing optional recorder remained alive");

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
