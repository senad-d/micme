import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { MAX_CAPTURED_OUTPUT_CHARS, MIN_AUDIO_BYTES, RECORDER_STOP_GRACE_MS } from "./constants.ts";
import { pcm16BufferLevel } from "./audio-level.ts";
import { sanitizeTerminalOutput, stripTerminalControlSequences } from "./terminal-text.ts";
import type { CommandSpec, ExitResult, Recording, RunResult } from "./types.ts";

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
		child.once("error", (error) => {
			settled = true;
			resolve({ code: null, signal: null, error });
		});
		child.once("close", (code, signal) => {
			settled = true;
			resolve({ code, signal });
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
		exit = await raceWithTimeout(active.exitPromise, 1_000);
	}
	if (!exit) {
		sendStopSignal(active, "SIGKILL");
		exit = await active.exitPromise;
	}
	return exit;
}

function sendStopSignal(active: Recording, signal: NodeJS.Signals) {
	try {
		if (!active.process.kill(signal)) return;
		active.stopSignals ??= new Set();
		active.stopSignals.add(signal);
	} catch {
		// The exit promise remains authoritative when the process settles during escalation.
	}
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
		let settled = false;
		let abortTimer: ReturnType<typeof setTimeout> | undefined;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const abort = () => {
			if (settled) return;
			cancelled = true;
			child.kill("SIGTERM");
			abortTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
		};
		const finish = () => {
			clearTimeout(timer);
			if (abortTimer) clearTimeout(abortTimer);
			options.signal?.removeEventListener("abort", abort);
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
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			finish();
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			finish();
			resolve({ code, signal, stdout, stderr, timedOut, ...(cancelled ? { cancelled: true } : {}) });
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
