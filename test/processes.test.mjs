import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function withPlatform(platform, fn) {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return fn();
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

test("shellQuote escapes platform quote characters byte-for-byte", () => {
	withPlatform("win32", () => {
		assert.equal(shellQuote('a"b'), String.raw`"a\"b"`);
	});
	withPlatform("linux", () => {
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

	withEnv({ PATH: `${badDir}${delimiter}${goodDir}` }, () => {
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

	withEnv({ PATH: `${shimDir}${delimiter}${binDir}`, PATHEXT: ".CmD;.bAt;.exe" }, () => {
		withPlatform("win32", () => {
			assert.equal(findExecutable(["whisper-cli"]), native);
		});
	});
});

test("Windows executable validation rejects an explicit batch path", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-windows-batch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const batch = join(root, "whisper-stream.CMD");
	await writeFile(batch, "@exit /b 0\r\n");

	withPlatform("win32", () => {
		assert.equal(isExecutableFile(batch), false);
	});
});

test("Windows command reporting can explicitly include a shell shim", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-windows-command-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const shim = join(root, "pi.CMD");
	await writeFile(shim, "@exit /b 0\r\n");

	withEnv({ PATH: root, PATHEXT: ".EXE;.CMD" }, () => {
		withPlatform("win32", () => {
			assert.equal(findExecutable(["pi"], { allowWindowsBatch: true }), shim);
		});
	});
});

test("Windows shell selection stays on the system interpreter across project directories", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "micme-shell-project-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	await writeFile(join(project, "cmd.exe"), "");

	const command = 'echo "hello world"';
	const expected = { command: String.raw`D:\Windows\System32\cmd.exe`, args: ["/d", "/s", "/c", command], display: command };
	const originalDirectory = process.cwd();
	try {
		withEnv({ SystemRoot: String.raw`D:\Windows`, PATH: project, ComSpec: String.raw`C:\Project\cmd.exe` }, () => {
			withPlatform("win32", () => {
				assert.deepEqual(shellCommand(command), expected);
				process.chdir(project);
				assert.deepEqual(shellCommand(command), expected);
			});
		});
	} finally {
		process.chdir(originalDirectory);
	}
});

test("Windows shell selection fails closed without a drive-qualified system root", () => {
	for (const SystemRoot of [undefined, "Windows", "C:Windows", String.raw`\Windows`, String.raw`\\server\share`]) {
		withEnv({ SystemRoot }, () => {
			withPlatform("win32", () => {
				assert.throws(() => shellCommand("echo hi"), /SystemRoot must be a drive-qualified absolute path/);
			});
		});
	}
});

test("configured Windows hooks pass the system interpreter and original shell arguments to spawn", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "micme-hook-spawn-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const audioPath = join(project, "raw.wav");
	const recordCommand = 'echo "recording hook"';
	const transcribeCommand = 'echo "transcription hook"';
	const spawn = childProcess.spawn;
	// Substitute a portable child at the OS boundary; keep the hook and runner logic real.
	const spawnMock = t.mock.method(childProcess, "spawn", (_command, _args, options) => spawn(process.execPath, ["-p", "'hook output'"], options));
	syncBuiltinESMExports();
	try {
		const [recording, transcription] = withEnv({ SystemRoot: String.raw`D:\Windows`, MICME_RECORD_COMMAND: recordCommand }, () =>
			withPlatform("win32", () => [
				spawnRecording(buildRecorderCommand(audioPath), audioPath, project),
				transcribeWithCustomCommand(transcribeCommand, audioPath, project),
			]),
		);
		const [exit, transcript] = await Promise.all([recording.exitPromise, transcription]);
		assert.equal(exit.code, 0);
		assert.equal(recording.stdout().trim(), "hook output");
		assert.equal(transcript.trim(), "hook output");
		assert.deepEqual(spawnMock.mock.calls.map(({ arguments: [command, args] }) => [command, args]), [
			[String.raw`D:\Windows\System32\cmd.exe`, ["/d", "/s", "/c", recordCommand]],
			[String.raw`D:\Windows\System32\cmd.exe`, ["/d", "/s", "/c", transcribeCommand]],
		]);
	} finally {
		spawnMock.mock.restore();
		syncBuiltinESMExports();
	}
});

function mockSignalChild(t, kill) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, kill });
	const spawnMock = t.mock.method(childProcess, "spawn", () => child);
	syncBuiltinESMExports();
	t.after(() => {
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
	const child = mockSignalChild(t, function (signal) {
		signals.push(signal);
		this.emit("error", signalPermissionError());
		return false;
	});
	const controller = new AbortController();
	const run = runProcess("mock-process", [], 10_000, { signal: controller.signal }).catch((error) => error);
	controller.abort();
	t.mock.timers.tick(1_000);
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
	const child = mockSignalChild(t, function (signal) {
		signals.push(signal);
		if (signal === "SIGINT") return true;
		this.emit("error", signalPermissionError());
		return false;
	});
	const recording = spawnRecording({ command: "mock-recorder", args: [], display: "mock recorder" }, "raw.wav", ".");
	const stop = stopProcess(recording).catch((error) => error);
	t.mock.timers.tick(RECORDER_STOP_GRACE_MS);
	await Promise.resolve();
	assert.equal(recording.isSettled(), false);
	t.mock.timers.tick(1_000);
	await Promise.resolve();
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
	const run = runProcess("mock-process", [], 25);
	t.mock.timers.tick(25);
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
	withPlatform("linux", () => {
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

test("recorder stop rejects a zero exit before stdio closes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-recorder-exit-before-close-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const audioPath = join(root, "raw.wav");
	await writeFile(audioPath, Buffer.alloc(600));

	const kill = t.mock.fn(() => false);
	const child = mockSignalChild(t, kill);
	const recording = spawnRecording({ command: "mock-recorder", args: [], display: "mock recorder" }, audioPath, root);
	child.exitCode = 0;
	child.emit("exit", 0, null);
	const stop = stopRecorder(recording);
	child.emit("close", 0, null);

	await assert.rejects(stop, /recorder exited unexpectedly \(code 0\)/);
	assert.equal(kill.mock.callCount(), 0);
});

test("recorder stop reports the known exit when stdio does not close within the grace period", async (t) => {
	const kill = t.mock.fn(() => false);
	const child = mockSignalChild(t, kill);
	const recording = spawnRecording({ command: "mock-recorder", args: [], display: "mock recorder" }, "raw.wav", ".");
	child.signalCode = "SIGTERM";
	child.emit("exit", null, "SIGTERM");
	const stop = stopRecorder(recording).catch((error) => error);

	t.mock.timers.tick(RECORDER_STOP_GRACE_MS);
	const failure = await Promise.race([stop, setImmediate("pending")]);
	assert.match(failure?.message ?? "", /recorder exited unexpectedly \(signal SIGTERM\)/);
	assert.equal(recording.isSettled(), false);
	assert.equal(kill.mock.callCount(), 0);
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

	const gracefulAudio = join(root, "graceful.wav");
	const graceful = spawnRecording(
		{
			command: process.execPath,
			args: [
				"-e",
				`require("node:fs").writeFileSync(${JSON.stringify(gracefulAudio)}, Buffer.alloc(600)); process.stdin.setEncoding("utf8"); process.stdin.on("data", (data) => { if (data.includes("q")) process.exit(0); }); setInterval(() => {}, 1000);`,
			],
			display: "graceful recorder",
			stopInput: "q\n",
		},
		gracefulAudio,
		root,
	);
	await waitForFile(gracefulAudio);
	await stopRecorder(graceful);
	assert.equal(graceful.stopRequested, true);

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
