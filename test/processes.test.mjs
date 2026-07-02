import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

	const timedOut = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], 25);
	assert.equal(timedOut.timedOut, true);
	assert.equal(formatRunExit(timedOut), "timeout");

	const shell = await runShell("printf shell", 2_000);
	assert.equal(shell.stdout, "shell");
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
