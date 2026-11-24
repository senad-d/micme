import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const {
	appendCapped,
	cleanup,
	findExecutable,
	formatExit,
	formatProcessOutput,
	formatRunExit,
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

	const shell = await runShell(process.platform === "win32" ? "echo shell" : "printf shell", 2_000);
	assert.equal(shell.stdout.trimEnd(), "shell");
	withPlatform("win32", () => {
		assert.deepEqual(shellCommand("echo hi"), { command: "cmd.exe", args: ["/d", "/s", "/c", "echo hi"], display: "echo hi" });
	});
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

async function makeProcessTree(t, { detached = false, closeStderrOnTerm = false, closeBeforeStop = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme-process-tree-"));
	const ready = join(root, "ready.json");
	const worker = `
		const fs = require("node:fs");
		const [ready, wrapperPid] = process.argv.slice(1);
		process.on("SIGINT", () => {});
		process.on("SIGTERM", () => { if (${closeStderrOnTerm}) fs.closeSync(2); });
		process.stderr.write("worker ready\\n");
		if (${closeBeforeStop}) fs.closeSync(2);
		fs.writeFileSync(ready + ".tmp", JSON.stringify([Number(wrapperPid), process.pid]));
		fs.renameSync(ready + ".tmp", ready);
		setTimeout(() => process.exit(0), 10_000);
	`;
	const wrapper = `
		const worker = require("node:child_process").spawn(process.execPath,
			["-e", ${JSON.stringify(worker)}, ${JSON.stringify(ready)}, String(process.pid)],
			{ stdio: ["ignore", "ignore", "inherit"], detached: ${detached}, windowsHide: true });
		if (${detached || closeBeforeStop}) worker.unref();
	`;
	t.after(async () => {
		const pids = await readFile(ready, "utf8").then(JSON.parse, () => []);
		for (const pid of pids) {
			if (await isProcessRunning(pid)) process.kill(pid, "SIGKILL");
		}
		await rm(root, { recursive: true, force: true });
	});
	return { root, ready, args: ["-e", wrapper] };
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
