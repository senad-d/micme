import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { delimiter, join, win32 } from "node:path";
import { setImmediate } from "node:timers/promises";
import { MAX_CAPTURED_OUTPUT_CHARS, MIN_AUDIO_BYTES, RECORDER_STOP_GRACE_MS } from "./constants.ts";
import { pcm16BufferLevel } from "./audio-level.ts";
import { sanitizeTerminalOutput, stripTerminalControlSequences } from "./terminal-text.ts";
import type { CommandSpec, ExitResult, Recording, RunResult } from "./types.ts";

const TERMINATE_GRACE_MS = 1_000;
const FAILED_KILL_CLOSE_GRACE_MS = 1_000;

export function spawnRecording(command: CommandSpec, audioPath: string, tempDir: string): Recording {
	const child = spawn(command.command, command.args, {
		...command.spawnOptions,
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
	if (!active.isSettled() && active.process.exitCode == null && active.process.signalCode == null) {
		// A child can already be dead while its exit notification is pending. Two check
		// phases leave a poll phase for that notification even when stop starts during I/O.
		await setImmediate();
		await setImmediate();
	}
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

export function runShell(template: string, timeoutMs: number, options: RunProcessOptions & { placeholders?: Record<string, string> } = {}) {
	if (options.signal?.aborted) return Promise.resolve(cancelledRun());
	return runCommand(shellCommand(template, options.placeholders), timeoutMs, options);
}

export function shellCommand(template: string, placeholders?: Record<string, string>): CommandSpec {
	const display = placeholders ? replacePlaceholders(template, placeholders) : template;
	if (process.platform === "win32") {
		// Use the host's Windows installation directory, not ComSpec or executable lookup.
		const systemRoot = process.env.SystemRoot;
		if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) {
			throw new Error("Micme cannot locate the Windows system shell: SystemRoot must be a drive-qualified absolute path.");
		}
		const interpreter = win32.join(systemRoot, "System32", "cmd.exe");
		if (placeholders) return windowsHookCommand(interpreter, template, placeholders, display);
		return { command: interpreter, args: ["/d", "/s", "/c", display], display };
	}
	return { command: "sh", args: ["-lc", display], display };
}

function windowsHookCommand(command: string, template: string, placeholders: Record<string, string>, display: string): CommandSpec {
	const hookEnv: NodeJS.ProcessEnv = {};
	let prefix: string | undefined;
	let delayedExpansion: boolean | undefined;
	const script = replacePlaceholders(template, placeholders, (value, key) => {
		prefix ??= `MICME_HOOK_${randomUUID().replaceAll("-", "")}`;
		const name = `${prefix}_${key}`;
		hookEnv[name] = value;
		// Percent expansion leaves inserted percent signs alone. A later bang scan
		// also strips carets, even if the bang belongs to another argument.
		const delimiter = /[!^]/.test(value) && (delayedExpansion ??= windowsDelayedExpansion(command)) ? "!" : "%";
		return `"${delimiter}${name}${delimiter}"`;
	});
	if (!prefix) return { command, args: ["/d", "/s", "/c", script], display };

	// Keep the host's expansion rules for Raw text. /s removes the outer quotes
	// without CRT escaping the inner quotes that belong to the hook.
	return {
		command,
		args: ["/d", "/s", "/c", `"${script}"`],
		display,
		spawnOptions: { env: { ...process.env, ...hookEnv }, windowsVerbatimArguments: true },
	};
}

function windowsDelayedExpansion(command: string) {
	// cmd removes the unmatched bang only when its default delayed expansion is on.
	const probe = spawnSync(command, ["/d", "/s", "/c", '"echo micme!probe"'], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 2_000,
		windowsHide: true,
		windowsVerbatimArguments: true,
	});
	const marker = probe.stdout?.trim();
	if (probe.error || probe.status !== 0 || (marker !== "micmeprobe" && marker !== "micme!probe")) {
		throw new Error("Micme could not determine the Windows shell's delayed expansion mode.", { cause: probe.error });
	}
	return marker === "micmeprobe";
}

export type RunProcessOptions = {
	signal?: AbortSignal;
};

export function runProcess(command: string, args: string[], timeoutMs: number, options: RunProcessOptions = {}): Promise<RunResult> {
	return runCommand({ command, args }, timeoutMs, options);
}

function cancelledRun(): RunResult {
	return { code: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: true };
}

function runCommand({ command, args, spawnOptions }: Pick<CommandSpec, "command" | "args" | "spawnOptions">, timeoutMs: number, options: RunProcessOptions): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			resolve(cancelledRun());
			return;
		}

		const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

export function replacePlaceholders(template: string, values: Record<string, string>, quote: (value: string, key: string) => string = shellQuote) {
	return template.replace(/\{([A-Za-z][A-Za-z0-9]*?)(Raw)?\}/g, (placeholder, key: string, rawSuffix: string | undefined) => {
		if (!Object.hasOwn(values, key)) return placeholder;
		const value = values[key] ?? "";
		return rawSuffix ? value : quote(value, key);
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
