import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

const {
	appendCapped,
	cleanup,
	findExecutable,
	formatExit,
	formatProcessOutput,
	formatRunExit,
	isExecutableFile,
	normalizeTranscript,
	raceWithTimeout,
	replacePlaceholders,
	runProcess,
	runShell,
	sendStopInput,
	shellCommand,
	shellQuote,
	spawnRecording,
	stopProcess,
	stopRecorder,
} = await import("../src/processes.ts");
const { buildRecorderCommand } = await import("../src/audio.ts");
const { RECORDER_STOP_GRACE_MS } = await import("../src/constants.ts");
const { transcribeWithCustomCommand } = await import("../src/transcription.ts");

async function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
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

async function withPlatform(platform, fn) {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return await fn();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

async function waitForFile(path) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await stat(path).then(() => true, () => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`file was not created: ${path}`);
}

test("replacePlaceholders does not expand placeholders introduced by values", () => {
	const audioPath = "/tmp/{tempDir}/raw.wav";
	const tempDir = "/tmp/micme-real-dir";
	const output = replacePlaceholders("cmd {audio} {audioRaw} {tempDir} {missing}", { audio: audioPath, tempDir });

	assert.equal(output, `cmd ${shellQuote(audioPath)} ${audioPath} ${shellQuote(tempDir)} {missing}`);
});

test("shellQuote escapes platform quote characters byte-for-byte", async () => {
	await withPlatform("win32", () => {
		assert.equal(shellQuote('a"b'), String.raw`"a\"b"`);
	});
	await withPlatform("linux", () => {
		assert.equal(shellQuote("a'b"), String.raw`'a'\''b'`);
	});
});

test("formatProcessOutput strips terminal control sequences and falls back to safe output", () => {
	assert.equal(formatProcessOutput("\x1b]52;c;clipboard\x07ok\x1b[31m!\x1b[0m"), "ok !");
	assert.equal(formatProcessOutput("before\x1bPignored payload\x1b\\after"), "before after");
	assert.equal(formatProcessOutput("\x1b]52;c;clipboard\x07", "safe fallback"), "safe fallback");
});

test("normalizeTranscript strips terminal control sequences from transcriber output", () => {
	assert.equal(normalizeTranscript("Hello\x1b]52;c;clipboard\x07\n\x1b[31mworld\x1b[0m"), "Hello world");
});

test("findExecutable ignores non-executable PATH entries", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX executable bits are not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-path-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const badDir = join(root, "bad");
	const goodDir = join(root, "good");
	await mkdir(join(badDir, "micme-tool"), { recursive: true });
	await mkdir(goodDir);
	const executable = join(goodDir, "micme-tool");
	await writeFile(executable, "#!/bin/sh\nexit 0\n");
	await chmod(executable, 0o755);

	await withEnv({ PATH: `${badDir}${delimiter}${goodDir}` }, () => {
		assert.equal(findExecutable(["micme-tool"]), executable);
	});
});

test("Windows executable discovery skips batch shims earlier on PATH", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-windows-path-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const shimDir = join(root, "shims");
	const binDir = join(root, "bin");
	await mkdir(shimDir);
	await mkdir(binDir);
	await writeFile(join(shimDir, "whisper-cli.CmD"), "@exit /b 0\r\n");
	await writeFile(join(shimDir, "whisper-cli.bAt"), "@exit /b 0\r\n");
	const native = join(binDir, "whisper-cli.exe");
	await writeFile(native, "");

	await withEnv({ PATH: `${shimDir}${delimiter}${binDir}`, PATHEXT: ".CmD;.bAt;.exe" }, () =>
		withPlatform("win32", () => {
			assert.equal(findExecutable(["whisper-cli"]), native);
		}),
	);
});

test("Windows executable validation rejects an explicit batch path", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-windows-batch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const batch = join(root, "whisper-stream.CMD");
	await writeFile(batch, "@exit /b 0\r\n");

	await withPlatform("win32", () => {
		assert.equal(isExecutableFile(batch), false);
	});
});

test("Windows command reporting can explicitly include a shell shim", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-windows-command-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const shim = join(root, "pi.CMD");
	await writeFile(shim, "@exit /b 0\r\n");

	await withEnv({ PATH: root, PATHEXT: ".EXE;.CMD" }, () =>
		withPlatform("win32", () => {
			assert.equal(findExecutable(["pi"], { allowWindowsBatch: true }), shim);
		}),
	);
});

test("Windows shell selection stays on the system interpreter across project directories", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "micme-shell-project-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	await writeFile(join(project, "cmd.exe"), "");

	const command = 'echo "hello world"';
	const expected = { command: String.raw`D:\Windows\System32\cmd.exe`, args: ["/d", "/s", "/c", command], display: command };
	const originalDirectory = process.cwd();
	try {
		await withEnv({ SystemRoot: String.raw`D:\Windows`, PATH: project, ComSpec: String.raw`C:\Project\cmd.exe` }, () =>
			withPlatform("win32", () => {
				assert.deepEqual(shellCommand(command), expected);
				process.chdir(project);
				assert.deepEqual(shellCommand(command), expected);
			}),
		);
	} finally {
		process.chdir(originalDirectory);
	}
});

test("Windows shell selection fails closed without a drive-qualified system root", async () => {
	for (const SystemRoot of [undefined, "Windows", "C:Windows", String.raw`\Windows`, String.raw`\\server\share`]) {
		await withEnv({ SystemRoot }, () =>
			withPlatform("win32", () => {
				assert.throws(() => shellCommand("echo hi"), /SystemRoot must be a drive-qualified absolute path/);
			}),
		);
	}
});

function mockHookLaunch(t) {
	const requests = [];
	const spawn = childProcess.spawn;
	const spawnMock = t.mock.method(childProcess, "spawn", (_command, args, options) => {
		const launcher = spawn(process.execPath, args, options);
		const send = launcher.send.bind(launcher);
		launcher.send = (message, ...rest) => {
			if (typeof message !== "object") return send(message, ...rest);
			requests.push(message);
			// Keep the actual supervisor and redirect only the hook's executable.
			return send({ ...message, command: process.execPath, args: ["-p", String.raw`'hook\x20output'`] }, ...rest);
		};
		return launcher;
	});
	syncBuiltinESMExports();
	t.after(() => {
		spawnMock.mock.restore();
		syncBuiltinESMExports();
	});
	return requests;
}

test("configured Windows hooks pass the system interpreter and original shell arguments to spawn", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "micme-hook-spawn-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const audioPath = join(project, "raw.wav");
	const recordCommand = 'echo "recording hook"';
	const transcribeCommand = 'echo "transcription hook"';
	const requests = mockHookLaunch(t);
	const [recording, transcription] = await withEnv({ SystemRoot: String.raw`D:\Windows`, MICME_RECORD_COMMAND: recordCommand }, () =>
		withPlatform("win32", async () => [
			spawnRecording(await buildRecorderCommand(audioPath), audioPath, project),
			transcribeWithCustomCommand(transcribeCommand, audioPath, project),
		]),
	);
	t.after(() => stopProcess(recording));
	const [exit, transcript] = await Promise.all([recording.exitPromise, transcription]);
	assert.equal(exit.code, 0);
	assert.equal(recording.stdout().trim(), "hook output");
	assert.equal(transcript.trim(), "hook output");
	assert.deepEqual(requests.map(({ command, args }) => [command, args]), [
		[String.raw`D:\Windows\System32\cmd.exe`, ["/d", "/s", "/c", recordCommand]],
		[String.raw`D:\Windows\System32\cmd.exe`, ["/d", "/s", "/c", transcribeCommand]],
	]);
});

for (const delayed of [false, true]) {
	const mode = delayed ? "on" : "off";

	test(`Windows hooks transport quoted placeholders separately with delayed expansion ${mode}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "micme-hook-args-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const tempDir = join(root, "%USERNAME%", "a & b!USERNAME!^");
		const audioPath = join(tempDir, "raw.wav");
		const template = 'tool {audio} {audio} {transcript} "{tempDirRaw}" {unknown}';
		const requests = mockHookLaunch(t);
		const probeMock = t.mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: delayed ? "micmeprobe\r\n" : "micme!probe\r\n" }));
		syncBuiltinESMExports();
		try {
			const [recording, transcription] = await withEnv({ SystemRoot: String.raw`D:\Windows`, MICME_RECORD_COMMAND: template, USERNAME: "expanded" }, () =>
				withPlatform("win32", async () => [
					spawnRecording(await buildRecorderCommand(audioPath, tempDir), audioPath, tempDir),
					transcribeWithCustomCommand(template, audioPath, tempDir),
				]),
			);
			t.after(() => stopProcess(recording));
			const [exit, transcript] = await Promise.all([recording.exitPromise, transcription]);
			assert.equal(exit.code, 0);
			assert.equal(transcript.trim(), "hook output");
			assert.equal(requests.length, 2);
			for (const { args, spawnOptions: options } of requests) {
				assert.deepEqual(args.slice(0, -1), ["/d", "/s", "/c"], "the hook must inherit the shell's expansion mode");
				const delimiter = delayed ? "!" : "%";
				const refs = new RegExp(String.raw`^"tool "${delimiter}(\w+)${delimiter}" "${delimiter}\1${delimiter}" "${delimiter}(\w+)${delimiter}" `).exec(args.at(-1));
				assert.ok(refs, "non-Raw placeholders must use the shell mode's quoted environment references");
				assert.ok(args.at(-1).endsWith(`"${tempDir}" {unknown}"`));
				assert.equal(options.windowsVerbatimArguments, true);
				assert.equal(options.env[refs[1]], audioPath);
				assert.equal(options.env[refs[2]], join(tempDir, "transcript.txt"));
				assert.equal(options.env.USERNAME, "expanded");
				assert.equal(Object.hasOwn(process.env, refs[1]), false);
				assert.equal(Object.hasOwn(process.env, refs[2]), false);
			}
		} finally {
			probeMock.mock.restore();
			syncBuiltinESMExports();
		}
	});
}

test("a Windows hook fails instead of guessing when its shell mode cannot be detected", async (t) => {
	const probeMock = t.mock.method(childProcess, "spawnSync", () => ({ status: 1, stdout: "" }));
	syncBuiltinESMExports();
	try {
		await withEnv({ SystemRoot: String.raw`D:\Windows` }, () => withPlatform("win32", () => {
			assert.throws(() => shellCommand("tool {audio}", { audio: String.raw`C:\!USERNAME!\raw.wav` }), /could not determine the Windows shell's delayed expansion mode/);
		}));
	} finally {
		probeMock.mock.restore();
		syncBuiltinESMExports();
	}
});

test("an already cancelled Windows hook does not start a shell mode probe", async (t) => {
	const probeMock = t.mock.method(childProcess, "spawnSync", () => assert.fail("cancelled hook started a cmd probe"));
	syncBuiltinESMExports();
	try {
		const result = await withEnv({ SystemRoot: String.raw`D:\Windows` }, () => withPlatform("win32", () => runShell("tool {audio}", 2_000, {
			signal: AbortSignal.abort(),
			placeholders: { audio: String.raw`C:\!USERNAME!\raw.wav` },
		})));
		assert.equal(result.cancelled, true);
	} finally {
		probeMock.mock.restore();
		syncBuiltinESMExports();
	}
});

test("both Windows hooks preserve literal paths and the host's Raw expansion behavior", { skip: process.platform !== "win32" && "requires Windows cmd.exe" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-literal-hook-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const tempDir = join(root, "%USERNAME%", "a & b!USERNAME!");
	await mkdir(tempDir, { recursive: true });
	const audioPath = join(tempDir, "raw.wav");
	const template = `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" {audio} {tempDir} {transcript} "{tempDirRaw}"`;
	const [baseline, recording, transcription] = await withEnv({ MICME_RECORD_COMMAND: template, USERNAME: "expanded" }, async () => [
		runShell("echo !USERNAME!", 2_000),
		spawnRecording(await buildRecorderCommand(audioPath, tempDir), audioPath, tempDir),
		transcribeWithCustomCommand(template, audioPath, tempDir),
	]);
	const [raw, exit, transcript] = await Promise.all([baseline, recording.exitPromise, transcription]);
	assert.equal(raw.code, 0);
	assert.ok(["expanded", "!USERNAME!"].includes(raw.stdout.trim()));
	const expected = [audioPath, tempDir, join(tempDir, "transcript.txt"), join(root, "expanded", `a & b${raw.stdout.trim()}`)];
	assert.equal(exit.code, 0, recording.stderr());
	assert.deepEqual(JSON.parse(recording.stdout()), expected);
	assert.deepEqual(JSON.parse(transcript), expected);
});

async function loadPosixSignalRunner() {
	if (process.platform !== "win32") return { runProcess, spawnRecording, stopProcess, stopRecorder };
	// These are mock supervisor tests, not tests of the host's process manager.
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { ...platform, value: "linux" });
	try {
		return await import("../src/processes.ts?mock-posix-supervisor");
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
}

const signalRunner = await loadPosixSignalRunner();

function mockSignalChild(t, signal) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const child = Object.assign(new EventEmitter(), {
		pid: 123,
		exitCode: null,
		signalCode: null,
		connected: true,
		stdout: new PassThrough(),
		send(message, callback) {
			if (typeof message === "string") signal.call(this, message, callback);
		},
		disconnect() { this.connected = false; },
		unref() {},
	});
	const spawnMock = t.mock.method(childProcess, "spawn", () => child);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.timers.reset();
		spawnMock.mock.restore();
		syncBuiltinESMExports();
	});
	return child;
}

function signalPermissionError() {
	return Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
}

test("process abort reports failed escalation and handles child errors until close", async (t) => {
	const signals = [];
	const child = mockSignalChild(t, function (signal, callback) {
		signals.push(signal);
		this.emit("error", signalPermissionError());
		callback(signalPermissionError());
	});
	const controller = new AbortController();
	const run = signalRunner.runProcess("mock-process", [], 10_000, { signal: controller.signal }).catch((error) => error);
	controller.abort();
	await setImmediate();
	t.mock.timers.tick(1_000);
	await setImmediate();
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

	t.mock.timers.tick(1_000);
	const failure = await Promise.race([run, setImmediate("pending")]);
	assert.match(failure?.message ?? "", /SIGKILL.*EPERM.*may still be running/);
	child.emit("error", signalPermissionError());
	t.mock.timers.tick(10_000);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	child.emit("close", 0, null);
	assert.equal(child.listenerCount("error"), 0);
});

test("recorder stop failure does not settle a live child", async (t) => {
	const signals = [];
	const child = mockSignalChild(t, function (signal, callback) {
		signals.push(signal);
		if (signal === "SIGINT") return callback(null);
		this.emit("error", signalPermissionError());
		callback(signalPermissionError());
	});
	const recording = signalRunner.spawnRecording({ command: "mock-recorder", args: [], display: "mock recorder" }, "raw.wav", ".");
	const stop = signalRunner.stopProcess(recording).catch((error) => error);
	await setImmediate();
	t.mock.timers.tick(RECORDER_STOP_GRACE_MS);
	await setImmediate();
	assert.equal(recording.isSettled(), false);
	t.mock.timers.tick(1_000);
	await setImmediate();
	assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGKILL"]);

	t.mock.timers.tick(1_000);
	const failure = await Promise.race([stop, setImmediate("pending")]);
	assert.match(failure?.message ?? "", /SIGKILL.*EPERM.*may still be running/);
	assert.equal(recording.isSettled(), false);
	assert.equal(await Promise.race([recording.exitPromise, "pending"]), "pending");
	child.emit("error", signalPermissionError());
	child.emit("close", 0, null);
	assert.deepEqual(await recording.exitPromise, { code: 0, signal: null });
	assert.equal(recording.isSettled(), true);
	assert.equal(child.listenerCount("error"), 0);
});

test("a real close wins over a failed SIGKILL on timeout", async (t) => {
	const child = mockSignalChild(t, () => {
		throw signalPermissionError();
	});
	const run = signalRunner.runProcess("mock-process", [], 25);
	t.mock.timers.tick(25);
	await setImmediate();
	child.emit("close", 0, null);
	const result = await run;
	assert.equal(result.code, 0);
	assert.equal(result.timedOut, true);
});

test("process runners capture output, timeouts, and shell details", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-process-run-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = await runProcess(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], 2_000);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, "out");
	assert.equal(result.stderr, "err");
	assert.equal(formatRunExit(result), "code 0");
	await assert.rejects(runProcess(join(root, "missing-command"), [], 2_000), { code: "ENOENT" });

	const timedOut = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], 25);
	assert.equal(timedOut.timedOut, true);
	assert.equal(formatRunExit(timedOut), "timeout");

	const cancellation = new AbortController();
	const cancelledProcess = runProcess(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], 2_000, { signal: cancellation.signal });
	setTimeout(() => cancellation.abort(), 25);
	const cancelled = await cancelledProcess;
	assert.equal(cancelled.cancelled, true);
	assert.equal(formatRunExit(cancelled), "cancelled");

	const alreadyCancelled = new AbortController();
	alreadyCancelled.abort();
	assert.equal((await runProcess("missing-command-that-must-not-spawn", [], 2_000, { signal: alreadyCancelled.signal })).cancelled, true);

	const shell = await runShell("echo shell", 2_000);
	assert.equal(shell.stdout.trim(), "shell");
	await withPlatform("linux", () => {
		assert.deepEqual(shellCommand("echo hi"), { command: "sh", args: ["-lc", "echo hi"], display: "echo hi" });
	});

	assert.equal(appendCapped("x".repeat(100_000), "tail").endsWith("tail"), true);
	assert.equal(await raceWithTimeout(Promise.resolve("done"), 1_000), "done");
	assert.equal(await raceWithTimeout(Promise.reject(new Error("nope")), 1_000), undefined);
	assert.equal(await raceWithTimeout(new Promise(() => undefined), 5), undefined);
	assert.equal(formatExit({ code: 0, signal: null }), "code 0");
	assert.equal(formatExit({ code: null, signal: "SIGTERM" }), "signal SIGTERM");
	assert.equal(formatExit({ code: null, signal: null, error: new Error("boom") }), "boom");

	const temp = join(root, "cleanup");
	await mkdir(temp);
	await writeFile(join(temp, "file"), "data");
	await cleanup(temp);
	await assert.rejects(readFile(join(temp, "file")), /ENOENT/);
});

async function makeProcessTree(t, { detached = false, closeStderrOnTerm = false, closeBeforeStop = false, flushOnStop = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme-process-tree-"));
	const ready = join(root, "ready.json");
	const audioPath = join(root, "recording.wav");
	const worker = `
		const fs = require("node:fs");
		const [ready, wrapperPid] = process.argv.slice(1);
		process.on("SIGINT", () => {});
		process.on("SIGTERM", () => { if (${closeStderrOnTerm}) fs.closeSync(2); });
		process.stderr.write("worker ready\\n");
		if (${closeBeforeStop}) fs.closeSync(2);
		if (${flushOnStop}) process.stdin.on("data", (chunk) => {
			if (!chunk.includes("q")) return;
			fs.writeFileSync(${JSON.stringify(audioPath)}, Buffer.alloc(600));
			process.exit(0);
		});
		fs.writeFileSync(ready + ".tmp", JSON.stringify([Number(wrapperPid), process.pid]));
		fs.renameSync(ready + ".tmp", ready);
		setTimeout(() => process.exit(0), 10_000);
	`;
	const wrapper = `
		const worker = require("node:child_process").spawn(process.execPath,
			["-e", ${JSON.stringify(worker)}, ${JSON.stringify(ready)}, String(process.pid)],
			{ stdio: [${JSON.stringify(flushOnStop ? "inherit" : "ignore")}, "ignore", "inherit"], detached: ${detached}, windowsHide: true });
		if (${detached || closeBeforeStop || flushOnStop}) worker.unref();
	`;
	t.after(async () => {
		const pids = await readFile(ready, "utf8").then(JSON.parse, () => []);
		for (const pid of pids) {
			if (await isProcessRunning(pid)) process.kill(pid, "SIGKILL");
		}
		await rm(root, { recursive: true, force: true });
	});
	return { root, ready, audioPath, args: ["-e", wrapper] };
}

async function isProcessRunning(pid) {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
	if (process.platform !== "linux") return true;
	// A reparented worker can remain a zombie in a container after it has exited.
	const proc = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
		if (error.code === "ENOENT" || error.code === "ESRCH") return "";
		throw error;
	});
	return Boolean(proc) && !/\) Z /.test(proc);
}

async function assertTreeExited(ready) {
	await assertPidsExited(JSON.parse(await readFile(ready, "utf8")));
}

async function assertPidsExited(pids) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (!(await Promise.all(pids.map(isProcessRunning))).some(Boolean)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`wrapper or worker still running: ${pids.join(", ")}`);
}

test("timeout stops both the wrapper and its pipe-inheriting worker", async (t) => {
	const fixture = await makeProcessTree(t);
	const outcome = await raceWithTimeout(runProcess(process.execPath, fixture.args, 1_500), 5_000);
	assert.equal(outcome?.timedOut, true);
	assert.match(outcome.stderr, /worker ready/);
	await assertTreeExited(fixture.ready);
});

test("abort escalates when the pipe-inheriting worker closes stderr but keeps running", async (t) => {
	const fixture = await makeProcessTree(t, { closeStderrOnTerm: true });
	const controller = new AbortController();
	const operation = runProcess(process.execPath, fixture.args, 8_000, { signal: controller.signal });
	await waitForFile(fixture.ready);
	controller.abort();
	const outcome = await raceWithTimeout(operation, 4_000);
	assert.equal(outcome?.cancelled, true);
	assert.equal(outcome.timedOut, false);
	await assertTreeExited(fixture.ready);
});

test("recorder stop escalates when the wrapper's pipe-inheriting worker ignores graceful signals", async (t) => {
	const { root, args, ready } = await makeProcessTree(t);
	const audioPath = join(root, "recording.wav");
	await writeFile(audioPath, Buffer.alloc(600));
	const recording = spawnRecording({ command: process.execPath, args, display: "recorder wrapper" }, audioPath, root);
	await waitForFile(ready);
	const result = await raceWithTimeout(stopRecorder(recording).then(() => "stopped"), 6_000);
	assert.equal(result, "stopped");
	await assertTreeExited(ready);
});

test("recorder stop lets an owned worker flush but still rejects an earlier zero exit from its wrapper", async (t) => {
	const { root, ready, audioPath, args } = await makeProcessTree(t, { flushOnStop: true });
	const recording = spawnRecording({ command: process.execPath, args, display: "recorder wrapper", stopInput: "q\n" }, audioPath, root);
	await waitForFile(ready);
	const [wrapper, worker] = JSON.parse(await readFile(ready, "utf8"));
	await assertPidsExited([wrapper]);
	assert.equal(await isProcessRunning(worker), true);
	assert.equal(recording.isSettled(), false, "the worker still owns the recorder pipe");

	await assert.rejects(stopRecorder(recording), /recorder exited unexpectedly \(code 0\)/);
	assert.equal((await stat(audioPath)).size, 600, "the worker should still receive the graceful stop input");
	await assertPidsExited([worker]);
});

test("recorder shutdown stops an owned worker after the wrapper and its pipes have closed", async (t) => {
	const { root, args, ready } = await makeProcessTree(t, { closeBeforeStop: true });
	const recording = spawnRecording({ command: process.execPath, args, display: "recorder wrapper" }, join(root, "recording.wav"), root);
	await waitForFile(ready);
	assert.equal((await raceWithTimeout(recording.exitPromise, 2_000))?.code, 0, "wrapper and pipes must close before shutdown");
	const [, worker] = JSON.parse(await readFile(ready, "utf8"));
	assert.equal(await isProcessRunning(worker), true, "worker must still be running before shutdown");

	const result = await raceWithTimeout(stopProcess(recording), 5_000);
	assert.equal(result?.code, 0);
	await assertTreeExited(ready);
});

test("recorder shutdown does not mistake a truncated process snapshot for an empty tree", { skip: process.platform === "win32" }, async (t) => {
	const { root, args, ready } = await makeProcessTree(t, { closeBeforeStop: true });
	const recording = spawnRecording({ command: process.execPath, args, display: "recorder wrapper" }, join(root, "recording.wav"), root);
	await waitForFile(ready);
	assert.equal((await raceWithTimeout(recording.exitPromise, 2_000))?.code, 0);
	const [, worker] = JSON.parse(await readFile(ready, "utf8"));
	assert.equal(await isProcessRunning(worker), true);

	const execFile = childProcess.execFile;
	let truncated = false;
	const snapshot = t.mock.method(childProcess, "execFile", (file, commandArgs, options, callback) => {
		assert.equal(file, "/bin/ps");
		if (truncated) return execFile("/bin/ps", commandArgs, options, callback);
		truncated = true;
		// A timeout can destroy the output streams after ps has exited with code 0.
		setTimeout(callback, options.timeout + 1, null, "", "");
		return { killed: true, exitCode: 0, signalCode: null };
	});
	syncBuiltinESMExports();
	t.after(() => {
		snapshot.mock.restore();
		syncBuiltinESMExports();
	});

	assert.equal((await raceWithTimeout(stopProcess(recording), 5_000))?.code, 0);
	await assertTreeExited(ready);
});

test("recorder shutdown never signals a recycled POSIX process group ID", { skip: process.platform === "win32" }, async (t) => {
	const { root, args, ready } = await makeProcessTree(t, { closeBeforeStop: true });
	const kill = process.kill;
	const straySignals = [];
	let groupReused = false;
	// Simulate reuse without signalling any unrelated OS process.
	t.mock.method(process, "kill", (pid, signal) => {
		if (pid >= 0) return kill(pid, signal);
		if (straySignals.length) throw Object.assign(new Error("group no longer exists"), { code: "ESRCH" });
		if (groupReused && signal !== 0) straySignals.push(signal);
		return true;
	});
	const recording = spawnRecording({ command: process.execPath, args, display: "recorder wrapper" }, join(root, "recording.wav"), root);
	await waitForFile(ready);
	assert.equal((await raceWithTimeout(recording.exitPromise, 2_000))?.code, 0);
	const [, worker] = JSON.parse(await readFile(ready, "utf8"));
	assert.equal(await isProcessRunning(worker), true);
	kill(worker, "SIGKILL");
	await assertPidsExited([worker]);
	// If ownership is retained by a separate launcher, simulate its loss too.
	const launcher = recording.process;
	if (launcher.exitCode === null && launcher.signalCode === null) {
		const closed = once(launcher, "close");
		launcher.kill("SIGKILL");
		assert.ok(await raceWithTimeout(closed, 2_000), "launcher must have exited before simulating reuse");
	}
	groupReused = true;
	assert.equal((await raceWithTimeout(stopProcess(recording), 1_000))?.code, 0);
	assert.deepEqual(straySignals, []);
});

test("successful runs leave background workers with closed pipes alone", async (t) => {
	const { args, ready } = await makeProcessTree(t, { closeBeforeStop: true });
	const result = await runProcess(process.execPath, args, 2_000);
	assert.equal(result.code, 0);
	await waitForFile(ready);
	const [, worker] = JSON.parse(await readFile(ready, "utf8"));
	assert.equal(await isProcessRunning(worker), true);
});

test("timeout settles even when a worker outside the process group holds the pipe", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await makeProcessTree(t, { detached: true });
	const outcome = await raceWithTimeout(runProcess(process.execPath, fixture.args, 1_500), 4_000);
	assert.equal(outcome?.timedOut, true);
	assert.notEqual(outcome.code, 0, "a successful wrapper exit must not mask the timeout");
	assert.match(outcome.stderr, /worker ready/);
	const [wrapper, worker] = JSON.parse(await readFile(fixture.ready, "utf8"));
	assert.equal(await isProcessRunning(wrapper), false);
	assert.equal(await isProcessRunning(worker), true);
});

test("owned recorder launch applies child-only environment options to the hook", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-hook-env-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const recording = spawnRecording({
		command: process.execPath,
		args: ["-e", "process.stdout.write(process.env.MICME_TEST_LAUNCH_VALUE ?? '')"],
		display: "node",
		spawnOptions: { env: { ...process.env, MICME_TEST_LAUNCH_VALUE: "hook-only" } },
	}, join(root, "recording.wav"), root);
	t.after(() => stopProcess(recording));
	assert.equal((await recording.exitPromise).code, 0);
	assert.equal(recording.stdout(), "hook-only");
});

test("recording process helpers collect output, meter levels, and stop safely", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-recording-process-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const audioPath = join(root, "raw.wav");

	const textRecording = spawnRecording(
		{ command: process.execPath, args: ["-e", "process.stdout.write('hello'); process.stderr.write('warn')"], display: "node" },
		audioPath,
		root,
	);
	assert.equal(textRecording.isSettled(), false);
	assert.deepEqual(await textRecording.exitPromise, { code: 0, signal: null });
	assert.equal(textRecording.isSettled(), true);
	assert.equal(textRecording.stdout(), "hello");
	assert.equal(textRecording.stderr(), "warn");

	const meterRecording = spawnRecording(
		{ command: process.execPath, args: ["-e", "process.stdout.write(Buffer.from([255, 127, 0, 0, 0, 128, 0, 0]))"], display: "node", meterFromStdout: true },
		audioPath,
		root,
	);
	await meterRecording.exitPromise;
	assert.ok(meterRecording.audioLevel() > 0);

	const writes = [];
	const active = {
		command: { stopInput: "q\n" },
		process: {
			stdin: {
				destroyed: false,
				writable: true,
				write(value) {
					writes.push(value);
				},
				end() {
					writes.push("end");
				},
			},
			kill() {
				writes.push("kill");
			},
		},
		isSettled: () => false,
		getExit: () => ({ code: null, signal: null }),
		exitPromise: Promise.resolve({ code: 0, signal: null }),
	};
	assert.equal(sendStopInput(active), true);
	await stopProcess(active);
	assert.deepEqual(writes.slice(0, 2), ["q\n", "end"]);
	assert.equal(sendStopInput({ command: {}, process: {}, isSettled: () => true, exitPromise: Promise.resolve({ code: 0, signal: null }) }), false);
	await stopProcess({ command: {}, process: {}, isSettled: () => true, exitPromise: Promise.resolve({ code: 0, signal: null }) });

	const missingAudio = {
		...active,
		isSettled: () => true,
		audioPath: join(root, "missing.wav"),
		stderr: () => "\x1b[31mrecorder failed\x1b[0m",
	};
	await assert.rejects(stopRecorder(missingAudio), /Recorder output:\nrecorder failed/);

	await writeFile(audioPath, Buffer.alloc(600));
	await stopRecorder({ ...missingAudio, audioPath, stderr: () => "" });
});

test("recorder stop lets the hook finish through stdin before terminating the tree", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-recorder-graceful-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const audioPath = join(root, "graceful.wav");
	const ready = join(root, "ready");
	const graceful = spawnRecording(
		{
			command: process.execPath,
			args: ["-e", `
				const fs = require("node:fs");
				const [ready, audio] = process.argv.slice(1);
				process.stdin.setEncoding("utf8");
				process.stdin.on("data", (data) => {
					if (data.includes("q")) {
						fs.writeFileSync(audio, Buffer.alloc(600));
						process.exit(0);
					}
				});
				fs.writeFileSync(ready, "");
				setTimeout(() => process.exit(2), 10_000);
			`, ready, audioPath],
			display: "graceful recorder",
			stopInput: "q\n",
		},
		audioPath,
		root,
	);
	await waitForFile(ready);
	await stopRecorder(graceful);
	assert.deepEqual(await graceful.exitPromise, { code: 0, signal: null });
});

test("recorder stop rejects a zero exit before stdio closes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-recorder-exit-before-close-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const audioPath = join(root, "raw.wav");
	await writeFile(audioPath, Buffer.alloc(600));

	const dispatch = t.mock.fn(() => assert.fail("cannot signal a closed supervisor"));
	const child = mockSignalChild(t, dispatch);
	const recording = signalRunner.spawnRecording({ command: "mock-recorder", args: [], display: "mock recorder" }, audioPath, root);
	child.disconnect();
	child.exitCode = 0;
	child.emit("exit", 0, null);
	const stop = signalRunner.stopRecorder(recording);
	child.emit("close", 0, null);

	await assert.rejects(stop, /recorder exited unexpectedly \(code 0\)/);
	assert.equal(dispatch.mock.callCount(), 0);
});

test("recorder stop reports the known exit when stdio does not close within the grace period", async (t) => {
	const dispatch = t.mock.fn(() => assert.fail("cannot signal a closed supervisor"));
	const child = mockSignalChild(t, dispatch);
	const recording = signalRunner.spawnRecording({ command: "mock-recorder", args: [], display: "mock recorder" }, "raw.wav", ".");
	child.disconnect();
	child.signalCode = "SIGTERM";
	child.emit("exit", null, "SIGTERM");
	const stop = signalRunner.stopRecorder(recording).catch((error) => error);

	await setImmediate();
	t.mock.timers.tick(RECORDER_STOP_GRACE_MS);
	const failure = await Promise.race([stop, setImmediate("pending")]);
	assert.match(failure?.message ?? "", /recorder exited unexpectedly \(signal SIGTERM\)/);
	assert.equal(recording.isSettled(), false);
	assert.equal(dispatch.mock.callCount(), 0);
	child.emit("close", null, "SIGTERM");
});

test("recorder stop rejects spontaneous failures and accepts owned stop paths", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX signal exit fixtures are not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-recorder-exit-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const nonzeroAudio = join(root, "nonzero.wav");
	const nonzero = spawnRecording(
		{
			command: process.execPath,
			args: [
				"-e",
				`require("node:fs").writeFileSync(${JSON.stringify(nonzeroAudio)}, Buffer.alloc(600)); process.stderr.write("\\u001b[31mdevice lost\\u001b[0m"); process.exit(7);`,
			],
			display: "late nonzero recorder",
		},
		nonzeroAudio,
		root,
	);
	await nonzero.exitPromise;
	await assert.rejects(stopRecorder(nonzero), (error) => {
		assert.match(error.message, /recorder exited unexpectedly \(code 7\)/);
		assert.match(error.message, /Recorder output:\ndevice lost/);
		assert.equal(error.message.includes("\u001b"), false);
		return true;
	});

	const missingAudio = join(root, "spawn-error.wav");
	await writeFile(missingAudio, Buffer.alloc(600));
	const spawnError = spawnRecording({ command: join(root, "missing-recorder"), args: [], display: "missing recorder" }, missingAudio, root);
	await spawnError.exitPromise;
	await assert.rejects(stopRecorder(spawnError), /recorder exited unexpectedly .*ENOENT/);

	const signalAudio = join(root, "signal.wav");
	const signalExit = spawnRecording(
		{
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(signalAudio)}, Buffer.alloc(600)); process.kill(process.pid, "SIGTERM");`],
			display: "signalled recorder",
		},
		signalAudio,
		root,
	);
	await signalExit.exitPromise;
	await assert.rejects(stopRecorder(signalExit), /recorder exited unexpectedly \(signal SIGTERM\)/);

	const escalatedAudio = join(root, "escalated.wav");
	const escalated = spawnRecording(
		{
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(escalatedAudio)}, Buffer.alloc(600)); setInterval(() => {}, 1000);`],
			display: "escalated recorder",
		},
		escalatedAudio,
		root,
	);
	await waitForFile(escalatedAudio);
	await stopRecorder(escalated);
	assert.equal(escalated.stopSignals?.has("SIGINT"), true);

	const ffmpegEscalationAudio = join(root, "ffmpeg-escalation.wav");
	const ffmpegEscalation = spawnRecording(
		{
			command: process.execPath,
			args: [
				"-e",
				`process.on("SIGINT", () => process.exit(255)); require("node:fs").writeFileSync(${JSON.stringify(ffmpegEscalationAudio)}, Buffer.alloc(600)); setInterval(() => {}, 1000);`,
			],
			display: "ffmpeg-style escalation",
			signalStopExitCodes: [255],
		},
		ffmpegEscalationAudio,
		root,
	);
	await waitForFile(ffmpegEscalationAudio);
	await stopRecorder(ffmpegEscalation);
	assert.equal(ffmpegEscalation.stopSignals?.has("SIGINT"), true);

	const failedStopAudio = join(root, "failed-stop.wav");
	const failedStop = spawnRecording(
		{
			command: process.execPath,
			args: [
				"-e",
				`require("node:fs").writeFileSync(${JSON.stringify(failedStopAudio)}, Buffer.alloc(600)); process.stdin.setEncoding("utf8"); process.stdin.on("data", () => process.exit(9)); setInterval(() => {}, 1000);`,
			],
			display: "failed stop recorder",
			stopInput: "q\n",
		},
		failedStopAudio,
		root,
	);
	await waitForFile(failedStopAudio);
	await assert.rejects(stopRecorder(failedStop), /recorder failed while stopping \(code 9\)/);
});
