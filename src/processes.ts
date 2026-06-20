import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { MAX_CAPTURED_OUTPUT_CHARS, MIN_AUDIO_BYTES, RECORDER_STOP_GRACE_MS } from "./constants.ts";
import { pcm16BufferLevel } from "./audio-level.ts";
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

export async function stopProcess(active: Recording) {
	if (!active.isSettled()) {
		active.stopRequested = true;
		let exit: ExitResult | undefined;
		if (sendStopInput(active)) {
			exit = await raceWithTimeout(active.exitPromise, RECORDER_STOP_GRACE_MS);
		}
		if (!exit) {
			active.process.kill("SIGINT");
			exit = await raceWithTimeout(active.exitPromise, RECORDER_STOP_GRACE_MS);
		}
		if (!exit) {
			active.process.kill("SIGTERM");
			exit = await raceWithTimeout(active.exitPromise, 1_000);
		}
		if (!exit) {
			active.process.kill("SIGKILL");
			await active.exitPromise;
		}
	} else {
		await active.exitPromise;
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
	await stopProcess(active);

	const audioStats = await stat(active.audioPath).catch(() => undefined);
	if (!audioStats || audioStats.size < MIN_AUDIO_BYTES) {
		const stderr = active.stderr().trim();
		const suffix = stderr ? `\nRecorder output:\n${stderr}` : "";
		throw new Error(`Micme recorder did not produce usable audio.${suffix}`);
	}
}

export function runShell(command: string, timeoutMs: number) {
	const spec = shellCommand(command);
	return runProcess(spec.command, spec.args, timeoutMs);
}

export function shellCommand(command: string): CommandSpec {
	if (process.platform === "win32") {
		return { command: "cmd.exe", args: ["/d", "/s", "/c", command], display: command };
	}
	return { command: "sh", args: ["-lc", command], display: command };
}

export function runProcess(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

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
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr, timedOut });
		});
	});
}

export function normalizeTranscript(text: string) {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

export function replacePlaceholders(template: string, values: Record<string, string>) {
	return template.replace(/\{([A-Za-z][A-Za-z0-9]*?)(Raw)?\}/g, (placeholder, key: string, rawSuffix: string | undefined) => {
		if (!Object.prototype.hasOwnProperty.call(values, key)) return placeholder;
		const value = values[key] ?? "";
		return rawSuffix ? value : shellQuote(value);
	});
}

export function findExecutable(names: string[]) {
	const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
	const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];

	for (const name of names) {
		for (const dir of dirs) {
			for (const extension of extensions) {
				const candidate = join(dir, process.platform === "win32" && !/\.[^.]+$/.test(name) ? `${name}${extension}` : name);
				if (isExecutableFile(candidate)) return candidate;
			}
		}
	}
	return undefined;
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

export function formatRunExit(result: RunResult) {
	if (result.timedOut) return "timeout";
	if (result.signal) return `signal ${result.signal}`;
	return `code ${result.code}`;
}

export function shellQuote(value: string) {
	if (process.platform === "win32") {
		return `"${value.replace(/"/g, '\\"')}"`;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
