import type { ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_CAPTURED_OUTPUT_CHARS, MIN_AUDIO_BYTES, RECORDER_STOP_GRACE_MS } from "./constants.ts";
import { pcm16BufferLevel } from "./audio-level.ts";
import { observePosixGroupClose, posixGroupHasWorkers, posixRecorderState, releasePosixGroup, signalPosixGroup, spawnPosixGroupProcess } from "./posix-process-group.ts";
import { sanitizeTerminalOutput, stripTerminalControlSequences } from "./terminal-text.ts";
import type { CommandSpec, ExitResult, Recording, RunResult } from "./types.ts";
import { WINDOWS_JOB_STOP_EXIT_CODE, closeWindowsJob, spawnWindowsJobProcess, terminateWindowsJob, windowsJobHasProcesses } from "./windows-process-job.ts";

const PROCESS_TERM_GRACE_MS = 1_000;
const PROCESS_PIPE_DRAIN_MS = 500;
const HOST_IS_WINDOWS = process.platform === "win32";

function spawnOwnedProcess(command: string, args: string[], pipeInput = false, retainUntilStop = false) {
	return HOST_IS_WINDOWS
		? spawnWindowsJobProcess(command, args, pipeInput, retainUntilStop)
		: spawnPosixGroupProcess(command, args, pipeInput);
}

function observeProcessClose(child: ChildProcess) {
	let settled: ExitResult | undefined;
	let getExit: () => ExitResult = () => ({ code: child.exitCode, signal: child.signalCode });
	const exitPromise = new Promise<ExitResult>((resolve) => {
		const settle = (exit: ExitResult) => {
			if (settled) return;
			settled = exit;
			resolve(exit);
		};
		child.once("error", (error) => settle({ code: null, signal: null, error }));
		if (!HOST_IS_WINDOWS) getExit = observePosixGroupClose(child, settle);
		child.once("close", (code, signal) => settle({ code, signal }));
	});
	return { exitPromise, isSettled: () => settled !== undefined, getExit: () => settled ?? getExit() };
}

export function spawnRecording(command: CommandSpec, audioPath: string, tempDir: string): Recording {
	const child = spawnOwnedProcess(command.command, command.args, Boolean(command.stopInput), true);
	const lifecycle = observeProcessClose(child);
	if (HOST_IS_WINDOWS) child.once("close", () => windowsJobHasProcesses(child));
	let stdout = "";
	let stderr = "";
	let audioLevel = 0;

	child.stdin?.on("error", () => undefined);

	if (command.meterFromStdout) {
		child.stdout?.on("data", (chunk: Buffer) => {
			audioLevel = audioLevel * 0.35 + pcm16BufferLevel(chunk) * 0.65;
		});
	} else {
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout = appendCapped(stdout, chunk);
		});
	}
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = appendCapped(stderr, chunk);
	});

	return {
		process: child,
		audioPath,
		tempDir,
		startedAt: Date.now(),
		command,
		audioLevel: () => audioLevel,
		...lifecycle,
		stdout: () => stdout,
		stderr: () => stderr,
	};
}

export function stopProcess(active: Recording) {
	if (active.stopPromise) return active.stopPromise;
	active.stopPromise = stopProcessOnce(active).finally(() => releaseOwnedTree(active.process));
	return active.stopPromise;
}

async function stopProcessOnce(active: Recording) {
	const { process: child, exitPromise } = active;
	let stoppingWorkers = false;
	if (active.isSettled()) {
		if (!await hasOwnedProcesses(child, 200)) return exitPromise;
	} else {
		const state = HOST_IS_WINDOWS ? "running" : await posixRecorderState(child);
		if (!active.isSettled()) {
			if (state === "running") active.stopRequested = true;
			stoppingWorkers = state === "workers";
		}
	}
	const exit = await stopRecorderTree(active);
	// A successful wrapper can hand off its open pipes to the actual recorder.
	// Stopping that worker is expected, but must not mask an earlier wrapper failure.
	if (stoppingWorkers && exit.code === 0) active.stopRequested = true;
	return exit;
}

async function stopRecorderTree(active: Recording) {
	const { process: child, exitPromise } = active;
	if (sendStopInput(active)) {
		const exit = await waitForTreeGrace(child, exitPromise, RECORDER_STOP_GRACE_MS);
		if (exit) return exit;
	}
	if (signalPosixGroup(child, "SIGINT")) {
		rememberStopSignal(active, "SIGINT");
		const exit = await waitForTreeGrace(child, exitPromise, RECORDER_STOP_GRACE_MS);
		if (exit) return exit;
	}
	if (signalPosixGroup(child, "SIGTERM")) {
		rememberStopSignal(active, "SIGTERM");
		const exit = await waitForTreeGrace(child, exitPromise, PROCESS_TERM_GRACE_MS);
		if (exit) return exit;
	}
	const wrapperRunning = !active.isSettled() && child.exitCode === null && child.signalCode === null;
	const forced = forceKillTree(child);
	if (forced === "windows-job" && wrapperRunning) active.windowsTreeStopped = true;
	if (forced === "signal") rememberStopSignal(active, "SIGKILL");
	return waitForFinalClose(child, exitPromise, active.getExit);
}

function rememberStopSignal(active: Recording, signal: NodeJS.Signals) {
	active.stopSignals ??= new Set();
	active.stopSignals.add(signal);
}

function hasOwnedProcesses(child: ChildProcess, remainingMs: number) {
	return HOST_IS_WINDOWS ? windowsJobHasProcesses(child) : posixGroupHasWorkers(child, remainingMs);
}

function releaseOwnedTree(child: ChildProcess) {
	if (HOST_IS_WINDOWS) closeWindowsJob(child);
	else releasePosixGroup(child);
}

function forceKillTree(child: ChildProcess) {
	if (!HOST_IS_WINDOWS) return signalPosixGroup(child, "SIGKILL") ? "signal" : undefined;
	if (terminateWindowsJob(child)) return "windows-job";
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	if (killChild(child)) return "signal";
}

function killChild(child: ChildProcess) {
	try {
		return child.kill("SIGKILL");
	} catch {
		// The bounded close wait still applies if signaling fails.
		return false;
	}
}

async function waitForTreeGrace(child: ChildProcess, exitPromise: Promise<ExitResult>, graceMs: number) {
	const deadline = performance.now() + graceMs;
	const exit = await raceWithTimeout(exitPromise, graceMs);
	if (!exit) return;
	// A worker can close its pipes before it finishes flushing the recording.
	// Give the remaining tree the same grace deadline as the wrapper.
	for (;;) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) return;
		if (!await hasOwnedProcesses(child, remaining)) return exit;
		await delay(Math.max(0, Math.min(100, deadline - performance.now())));
	}
}

async function waitForFinalClose(child: ChildProcess, exitPromise: Promise<ExitResult>, getExit?: () => ExitResult): Promise<ExitResult> {
	// The POSIX supervisor performs the final kill itself. Keep IPC open for it
	// even if the wrapper result was already delivered and the pipes were closed.
	const closed = !HOST_IS_WINDOWS && child.pid && child.exitCode === null && child.signalCode === null
		? Promise.all([exitPromise, new Promise<void>((resolve) => child.once("exit", () => resolve()))]).then(([exit]) => exit)
		: exitPromise;
	const exit = await raceWithTimeout(closed, PROCESS_PIPE_DRAIN_MS);
	if (exit) return exit;
	const result = getExit?.() ?? { code: child.exitCode, signal: child.signalCode };

	// If a worker still holds inherited descriptors, stop waiting for EOF.
	child.stdin?.destroy();
	child.stdout?.destroy();
	child.stderr?.destroy();
	child.channel?.unref();
	child.unref();
	return result;
}

export function sendStopInput(active: Recording) {
	if (!active.command.stopInput || !active.process.stdin || active.process.stdin.destroyed || !active.process.stdin.writable) return false;
	try {
		active.process.stdin.write(active.command.stopInput);
		active.process.stdin.end();
		return true;
	} catch {
		return false;
	}
}

export async function stopRecorder(active: Recording) {
	const exit = await stopProcess(active);
	assertExpectedProcessExit(active, exit, "recorder");

	const audioStats = await stat(active.audioPath).catch(() => undefined);
	if (!audioStats || audioStats.size < MIN_AUDIO_BYTES) {
		const stderr = formatProcessOutput(active.stderr());
		const suffix = stderr ? `\nRecorder output:\n${stderr}` : "";
		throw new Error(`Micme recorder did not produce usable audio.${suffix}`);
	}
}

export function runShell(command: string, timeoutMs: number, options: RunProcessOptions = {}) {
	const spec = shellCommand(command);
	return runProcess(spec.command, spec.args, timeoutMs, options);
}

export function shellCommand(command: string): CommandSpec {
	if (process.platform === "win32") {
		return { command: "cmd.exe", args: ["/d", "/s", "/c", command], display: command };
	}
	return { command: "sh", args: ["-lc", command], display: command };
}

export type RunProcessOptions = {
	signal?: AbortSignal;
};

export async function runProcess(command: string, args: string[], timeoutMs: number, options: RunProcessOptions = {}): Promise<RunResult> {
	if (options.signal?.aborted) {
		return { code: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: true };
	}

	const child = spawnOwnedProcess(command, args);
	const { exitPromise, getExit } = observeProcessClose(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout = appendCapped(stdout, chunk);
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr = appendCapped(stderr, chunk);
	});

	let interrupt!: (cause: "timeout" | "cancelled") => void;
	const interruption = new Promise<"timeout" | "cancelled">((resolve) => {
		interrupt = resolve;
	});
	const timer = setTimeout(interrupt, timeoutMs, "timeout");
	const abort = interrupt.bind(undefined, "cancelled");
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const outcome = await Promise.race([exitPromise, interruption]);
	clearTimeout(timer);
	options.signal?.removeEventListener("abort", abort);

	const timedOut = outcome === "timeout";
	const cancelled = outcome === "cancelled";
	const exit = typeof outcome === "string"
		? await stopInterruptedRun(child, exitPromise, getExit, cancelled).finally(() => releaseOwnedTree(child))
		: outcome;
	if (typeof outcome !== "string") releaseOwnedTree(child);
	if (exit.error) throw exit.error;
	// A wrapper may have exited with code 0 while the hook was still running.
	const code = (timedOut || cancelled) && exit.code === 0 ? null : exit.code;
	return { code, signal: exit.signal, stdout, stderr, timedOut, ...(cancelled ? { cancelled: true } : {}) };
}

async function stopInterruptedRun(child: ChildProcess, exitPromise: Promise<ExitResult>, getExit: () => ExitResult, cancelled: boolean) {
	if (cancelled && signalPosixGroup(child, "SIGTERM")) {
		await waitForTreeGrace(child, exitPromise, PROCESS_TERM_GRACE_MS);
	}
	// Even if the snapshot looked empty, end an interrupted run through the
	// identity-safe supervisor rather than releasing a possibly live group.
	forceKillTree(child);
	return waitForFinalClose(child, exitPromise, getExit);
}

export function normalizeTranscript(text: string) {
	return stripTerminalControlSequences(text)
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

export function replacePlaceholders(template: string, values: Record<string, string>) {
	return template.replace(/\{([A-Za-z][A-Za-z0-9]*?)(Raw)?\}/g, (placeholder, key: string, rawSuffix: string | undefined) => {
		if (!Object.hasOwn(values, key)) return placeholder;
		const value = values[key] ?? "";
		return rawSuffix ? value : shellQuote(value);
	});
}

export function findExecutable(names: string[]) {
	const dirs = getPathDirectories();
	const extensions = getExecutableExtensions();

	for (const name of names) {
		const executable = findExecutableByName(name, dirs, extensions);
		if (executable) return executable;
	}
	return undefined;
}

function getPathDirectories() {
	return (process.env.PATH || "").split(delimiter).filter(Boolean);
}

function getExecutableExtensions() {
	return process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
}

function findExecutableByName(name: string, dirs: string[], extensions: string[]) {
	for (const dir of dirs) {
		const executable = findExecutableInDirectory(name, dir, extensions);
		if (executable) return executable;
	}
	return undefined;
}

function findExecutableInDirectory(name: string, dir: string, extensions: string[]) {
	for (const extension of extensions) {
		const candidate = join(dir, getExecutableFileName(name, extension));
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

function getExecutableFileName(name: string, extension: string) {
	return process.platform === "win32" && !/\.[^.]+$/.test(name) ? `${name}${extension}` : name;
}

export function isExecutableFile(path: string) {
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return false;
		if (process.platform === "win32") return true;
		accessSync(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function appendCapped(current: string, chunk: string) {
	const next = current + chunk;
	return next.length > MAX_CAPTURED_OUTPUT_CHARS ? next.slice(-MAX_CAPTURED_OUTPUT_CHARS) : next;
}

export function formatProcessOutput(...outputs: string[]) {
	for (const output of outputs) {
		const sanitized = sanitizeTerminalOutput(output);
		if (sanitized) return sanitized;
	}
	return "";
}

export function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

export async function cleanup(tempDir: string) {
	await rm(tempDir, { recursive: true, force: true });
}

export function formatExit(exit: ExitResult) {
	if (exit.error) return exit.error.message;
	if (exit.signal) return `signal ${exit.signal}`;
	return `code ${exit.code}`;
}

export function assertExpectedProcessExit(active: Recording, exit: ExitResult, label: string) {
	if (isExpectedProcessExit(active, exit)) return;
	const action = active.stopRequested ? "failed while stopping" : "exited unexpectedly";
	const reason = formatProcessOutput(appendCapped("", formatExit(exit))) || "unknown process result";
	const stderr = formatProcessOutput(active.stderr());
	const suffix = stderr ? `\n${formatProcessLabel(label)} output:\n${stderr}` : "";
	throw new Error(`Micme ${label} ${action} (${reason}).${suffix}`);
}

function isExpectedProcessExit(active: Recording, exit: ExitResult) {
	if (!active.stopRequested || exit.error) return false;
	if (exit.code === 0) return true;
	if (exit.signal) return active.stopSignals?.has(exit.signal) ?? false;
	if (exit.code === null) return false;
	// Windows Job Object termination leaves the code passed to TerminateJobObject.
	if (exit.code === WINDOWS_JOB_STOP_EXIT_CODE && active.windowsTreeStopped) return true;
	if (!active.stopSignals?.size) return false;
	if (active.command.signalStopExitCodes?.includes(exit.code)) return true;
	return [...active.stopSignals].some((signal) => exit.code === getSignalExitCode(signal));
}

function getSignalExitCode(signal: NodeJS.Signals) {
	switch (signal) {
		case "SIGINT":
			return 130;
		case "SIGTERM":
			return 143;
		case "SIGKILL":
			return 137;
		default:
			return undefined;
	}
}

function formatProcessLabel(label: string) {
	return label ? `${label[0]?.toUpperCase()}${label.slice(1)}` : "Process";
}

export function formatRunExit(result: RunResult) {
	if (result.cancelled) return "cancelled";
	if (result.timedOut) return "timeout";
	if (result.signal) return `signal ${result.signal}`;
	return `code ${result.code}`;
}

export function shellQuote(value: string) {
	if (process.platform === "win32") {
		const escapedValue = value.replaceAll('"', String.raw`\"`);
		return `"${escapedValue}"`;
	}
	const escapedValue = value.replaceAll("'", String.raw`'\''`);
	return `'${escapedValue}'`;
}
