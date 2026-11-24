import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { delimiter, join, win32 } from "node:path";
import { MAX_CAPTURED_OUTPUT_CHARS, MIN_AUDIO_BYTES, RECORDER_STOP_GRACE_MS } from "./constants.ts";
import { pcm16BufferLevel } from "./audio-level.ts";
import { sanitizeTerminalOutput, stripTerminalControlSequences } from "./terminal-text.ts";
import type { CommandSpec, ExitResult, Recording, RunResult } from "./types.ts";

const TERMINATE_GRACE_MS = 1_000;
const FAILED_KILL_CLOSE_GRACE_MS = 1_000;

export function spawnRecording(command: CommandSpec, audioPath: string, tempDir: string): Recording {
	const child = spawn(command.command, command.args, {
		stdio: [command.stopInput ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	let stdout = "";
	let stderr = "";
	let settled = false;
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

	const exitPromise = new Promise<ExitResult>((resolve) => {
		observeProcessExit(child, (exit) => {
			settled = true;
			resolve(exit);
		});
	});

	return {
		process: child,
		audioPath,
		tempDir,
		startedAt: Date.now(),
		command,
		audioLevel: () => audioLevel,
		exitPromise,
		isSettled: () => settled,
		stdout: () => stdout,
		stderr: () => stderr,
	};
}

export function stopProcess(active: Recording) {
	if (active.stopPromise) return active.stopPromise;
	active.stopPromise = stopProcessOnce(active);
	return active.stopPromise;
}

async function stopProcessOnce(active: Recording) {
	if (active.isSettled()) return active.exitPromise;

	const { exitCode: code, signalCode: signal } = active.process;
	// Give diagnostics time to drain without claiming the exit or waiting indefinitely on inherited pipes.
	if (code != null || signal != null) {
		return (await raceWithTimeout(active.exitPromise, RECORDER_STOP_GRACE_MS)) ?? { code, signal };
	}

	active.stopRequested = true;
	let exit: ExitResult | undefined;
	if (sendStopInput(active)) {
		exit = await raceWithTimeout(active.exitPromise, RECORDER_STOP_GRACE_MS);
	}
	if (!exit) {
		sendStopSignal(active, "SIGINT");
		exit = await raceWithTimeout(active.exitPromise, RECORDER_STOP_GRACE_MS);
	}
	if (!exit) {
		sendStopSignal(active, "SIGTERM");
		exit = await raceWithTimeout(active.exitPromise, TERMINATE_GRACE_MS);
	}
	if (exit) return exit;

	const failure = sendStopSignal(active, "SIGKILL");
	if (!failure) return active.exitPromise;
	// A failed kill can race with a real exit. Bound the stop attempt, not the exit promise.
	exit = await raceWithTimeout(active.exitPromise, FAILED_KILL_CLOSE_GRACE_MS);
	if (exit) return exit;
	throw failure;
}

function sendStopSignal(active: Recording, signal: NodeJS.Signals) {
	const failure = sendProcessSignal(active.process, signal);
	if (failure) return failure;
	active.stopSignals ??= new Set();
	active.stopSignals.add(signal);
}

function observeProcessExit(child: ChildProcess, settle: (exit: ExitResult) => void) {
	let launchFailed = false;
	const onError = (error: Error) => {
		// Node assigns the PID before emitting 'spawn', so even an immediate signal can fail after launch.
		if (child.pid !== undefined || launchFailed) return;
		launchFailed = true;
		settle({ code: null, signal: null, error });
	};
	child.on("error", onError);
	child.once("close", (code, signal) => {
		child.off("error", onError);
		if (!launchFailed) settle({ code, signal });
	});
}

function sendProcessSignal(child: ChildProcess, signal: NodeJS.Signals) {
	let cause: unknown;
	const captureError = (error: Error) => {
		cause = error;
	};
	// ChildProcess.kill() can emit an error synchronously or throw instead.
	child.on("error", captureError);
	try {
		if (child.kill(signal) && cause === undefined) return;
	} catch (error) {
		cause = error;
	} finally {
		child.off("error", captureError);
	}
	const reason = cause instanceof Error ? formatProcessOutput(appendCapped("", cause.message)) : "";
	return new Error(`Micme could not send ${signal}${reason ? ` (${reason})` : ""}; the child process may still be running.`, { cause });
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
		// Use the host's Windows installation directory, not ComSpec or executable lookup.
		const systemRoot = process.env.SystemRoot;
		if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) {
			throw new Error("Micme cannot locate the Windows system shell: SystemRoot must be a drive-qualified absolute path.");
		}
		return { command: win32.join(systemRoot, "System32", "cmd.exe"), args: ["/d", "/s", "/c", command], display: command };
	}
	return { command: "sh", args: ["-lc", command], display: command };
}

export type RunProcessOptions = {
	signal?: AbortSignal;
};

export function runProcess(command: string, args: string[], timeoutMs: number, options: RunProcessOptions = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
			return;
		}

		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let cancelled = false;
		let finished = false;
		let killAttempted = false;
		let abortTimer: ReturnType<typeof setTimeout> | undefined;
		let failedKillTimer: ReturnType<typeof setTimeout> | undefined;

		const timer = setTimeout(() => {
			timedOut = true;
			forceStop();
		}, timeoutMs);
		const abort = () => {
			if (finished || cancelled) return;
			cancelled = true;
			if (killAttempted) return;
			abortTimer = setTimeout(forceStop, TERMINATE_GRACE_MS);
			sendProcessSignal(child, "SIGTERM");
		};
		const finish = () => {
			finished = true;
			clearTimeout(timer);
			clearTimeout(abortTimer);
			clearTimeout(failedKillTimer);
			options.signal?.removeEventListener("abort", abort);
		};
		const forceStop = () => {
			if (finished || killAttempted) return;
			killAttempted = true;
			clearTimeout(abortTimer);
			const failure = sendProcessSignal(child, "SIGKILL");
			if (!failure || finished) return;
			failedKillTimer = setTimeout(() => {
				finish();
				reject(failure);
			}, FAILED_KILL_CLOSE_GRACE_MS);
		};
		options.signal?.addEventListener("abort", abort, { once: true });

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout = appendCapped(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = appendCapped(stderr, chunk);
		});
		observeProcessExit(child, ({ code, signal, error }) => {
			if (finished) return;
			finish();
			if (error) reject(error);
			else resolve({ code, signal, stdout, stderr, timedOut, ...(cancelled ? { cancelled: true } : {}) });
		});
		if (options.signal?.aborted) abort();
	});
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

export function findExecutable(names: string[], { allowWindowsBatch = false }: { allowWindowsBatch?: boolean } = {}) {
	const dirs = getPathDirectories();
	const extensions = getExecutableExtensions();
	const isCandidate = allowWindowsBatch ? isFileWithExecuteAccess : isExecutableFile;

	for (const name of names) {
		const executable = findExecutableByName(name, dirs, extensions, isCandidate);
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

function findExecutableByName(name: string, dirs: string[], extensions: string[], isCandidate: typeof isExecutableFile) {
	for (const dir of dirs) {
		const executable = findExecutableInDirectory(name, dir, extensions, isCandidate);
		if (executable) return executable;
	}
	return undefined;
}

function findExecutableInDirectory(name: string, dir: string, extensions: string[], isCandidate: typeof isExecutableFile) {
	for (const extension of extensions) {
		const candidate = join(dir, getExecutableFileName(name, extension));
		if (isCandidate(candidate)) return candidate;
	}
	return undefined;
}

function getExecutableFileName(name: string, extension: string) {
	return process.platform === "win32" && !/\.[^.]+$/.test(name) ? `${name}${extension}` : name;
}

export function isExecutableFile(path: string) {
	// Batch files need a command interpreter, even when listed in PATHEXT.
	if (process.platform === "win32" && /\.(?:bat|cmd)[. ]*$/i.test(path)) return false;
	return isFileWithExecuteAccess(path);
}

function isFileWithExecuteAccess(path: string) {
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
	if (exit.code === null || !active.stopSignals?.size) return false;
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
