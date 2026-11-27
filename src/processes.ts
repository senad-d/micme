import { spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants as fsConstants, fstatSync, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { delimiter, join, resolve, win32 } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { MAX_CAPTURED_OUTPUT_CHARS, MIN_AUDIO_BYTES, RECORDER_STOP_GRACE_MS } from "./constants.ts";
import { pcm16BufferLevel } from "./audio-level.ts";
import { observePosixGroupClose, posixGroupHasWorkers, posixRecorderState, releasePosixGroup, signalPosixGroup, spawnPosixGroupProcess } from "./posix-process-group.ts";
import type { RecordingDirectory } from "./recording-dir.ts";
import { sanitizeTerminalOutput, stripTerminalControlSequences } from "./terminal-text.ts";
import type { CommandSpec, ExitResult, OwnedProcess, Recording, RunResult } from "./types.ts";
import { WINDOWS_JOB_STOP_EXIT_CODE, WindowsHookLaunchError, closeWindowsJob, spawnWindowsJobProcess, terminateWindowsJob, windowsJobHasProcesses } from "./windows-process-job.ts";

const PROCESS_TERM_GRACE_MS = 1_000;
const PROCESS_PIPE_DRAIN_MS = 500;
const FAILED_KILL_CLOSE_GRACE_MS = 1_000;
const HOST_IS_WINDOWS = process.platform === "win32";

type SpawnSpec = Pick<CommandSpec, "command" | "args" | "spawnOptions">;

function spawnOwnedProcess({ command, args, spawnOptions }: SpawnSpec, pipeInput = false, retainUntilStop = false, cwdFd?: number) {
	if (HOST_IS_WINDOWS) return spawnWindowsJobProcess(command, args, pipeInput, retainUntilStop, spawnOptions);
	// Relative executable paths were resolved from Pi's cwd, not the workspace
	// entered by a descriptor-relative launch.
	let executable = command;
	if (cwdFd !== undefined) executable = command === "sh" ? "/bin/sh" : resolve(command);
	return spawnPosixGroupProcess(executable, args, pipeInput, retainUntilStop, spawnOptions, cwdFd);
}

function observeProcessClose(child: ChildProcess, reportExit?: (exit: ExitResult) => void) {
	let settled: ExitResult | undefined;
	let getExit: () => ExitResult = () => ({ code: child.exitCode, signal: child.signalCode });
	const exitPromise = new Promise<ExitResult>((resolve) => {
		const settle = (exit: ExitResult) => {
			if (settled) return;
			settled = exit;
			reportExit?.(exit);
			resolve(exit);
		};
		// An operational error after launch is not an exit. Keep the listener
		// until close even when the caller is no longer waiting for the child.
		const onError = (error: Error) => {
			if (child.pid === undefined || error instanceof WindowsHookLaunchError) settle({ code: null, signal: null, error });
		};
		child.on("error", onError);
		if (!HOST_IS_WINDOWS) getExit = observePosixGroupClose(child, settle, reportExit);
		else if (reportExit) child.once("exit", (code, signal) => reportExit({ code, signal }));
		child.once("close", (code, signal) => {
			child.off("error", onError);
			settle({ code, signal });
		});
	});
	return { exitPromise, isSettled: () => settled !== undefined, getExit: () => settled ?? getExit() };
}

function spawnOwnedInteractive(command: CommandSpec, pipeInput: boolean, cwdFd?: number): OwnedProcess {
	const child = spawnOwnedProcess(command, pipeInput, true, cwdFd);
	// The hook can exit while the supervisor and inherited output pipes stay open.
	const { promise: exitObserved, resolve: reportExit } = deferred<ExitResult>();
	const lifecycle = observeProcessClose(child, reportExit);
	if (HOST_IS_WINDOWS) child.once("close", () => windowsJobHasProcesses(child));
	child.stdin?.on("error", () => undefined);
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = appendCapped(stderr, chunk);
	});
	return { process: child, command, exitObserved, ...lifecycle, stderr: () => stderr };
}

export function spawnLiveWorker({ command, args, display, spawnOptions }: CommandSpec): OwnedProcess {
	// Worker stdin is binary PCM; neither its stdout nor its stop semantics
	// belong to the recorder's text and quit-string path.
	return spawnOwnedInteractive({ command, args, display, spawnOptions }, true);
}

export function spawnRecording(command: CommandSpec, audioPath: string, tempDir: string, directory?: RecordingDirectory): Recording {
	const startedAtMonotonic = performance.now();
	const owned = spawnOwnedInteractive(command, Boolean(command.stopInput), command.useCallerCwd ? undefined : directory?.cwdFd);
	const child = owned.process;
	let stdout = "";
	let audioLevel = 0;

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

	return { ...owned, audioPath, tempDir, directory, startedAt: Date.now(), startedAtMonotonic, audioLevel: () => audioLevel, stdout: () => stdout };
}

export function stopProcess(active: OwnedProcess) {
	if (active.stopPromise) return active.stopPromise;
	active.stopPromise = stopProcessOnce(active).finally(() => releaseOwnedTree(active.process));
	return active.stopPromise;
}

async function stopProcessOnce(active: OwnedProcess) {
	const { process: child, exitPromise } = active;
	if (!active.isSettled() && !hasExit(active.getExit())) {
		// The launcher can have a hook PID or exit report queued. Leave a poll
		// phase for IPC before attributing the hook's exit to our stop request.
		await setImmediate();
		await setImmediate();
	}
	if (active.isSettled()) {
		if (!await hasOwnedProcesses(child, 200)) return exitPromise;
		return stopRecorderTree(active);
	}

	const initialExit = active.getExit();
	const state = !HOST_IS_WINDOWS && !hasExit(initialExit) ? await posixRecorderState(child) : "running";
	const exit = active.getExit();
	if (active.isSettled() || hasExit(exit) || state !== "running") {
		// A wrapper exit before stop is unexpected even if its workers are still
		// alive. Let inherited stdin and diagnostics drain before signalling them.
		if (await hasOwnedProcesses(child, 200)) return stopRecorderTree(active, true);
		const drained = await raceWithTimeout(exitPromise, RECORDER_STOP_GRACE_MS);
		if (drained) return drained;
		const result = active.getExit();
		abandonProcessPipes(child);
		return result;
	}

	active.stopRequested = true;
	return stopRecorderTree(active);
}

export function hasRecorderExited(active: Recording) {
	return active.isSettled() || hasExit(active.getExit());
}

function hasExit(exit: ExitResult) {
	return exit.code != null || exit.signal != null || exit.error !== undefined;
}

async function stopRecorderTree(active: OwnedProcess, drainBeforeSignalling = false) {
	const { process: child, exitPromise } = active;
	if (sendStopInput(active) || drainBeforeSignalling) {
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
	const wrapperRunning = !hasExit(active.getExit());
	const forced = await forceKillTree(child);
	if (forced instanceof Error) return waitAfterFailedKill(child, exitPromise, forced);
	if (forced === "windows-job" && wrapperRunning) active.windowsTreeStopped = true;
	if (forced === "signal") rememberStopSignal(active, "SIGKILL");
	return waitForFinalClose(child, exitPromise, active.getExit);
}

function rememberStopSignal(active: OwnedProcess, signal: NodeJS.Signals) {
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

async function forceKillTree(child: ChildProcess) {
	try {
		if (HOST_IS_WINDOWS) return terminateWindowsJob(child) ? "windows-job" : killFailure();
		const sent = await raceWithTimeout(requestPosixKill(child), FAILED_KILL_CLOSE_GRACE_MS);
		return sent?.ok ? "signal" : killFailure(sent?.cause);
	} catch (error) {
		return killFailure(error);
	}
}

function requestPosixKill(child: ChildProcess) {
	return new Promise<{ ok: boolean; cause?: unknown }>((resolve) => {
		if (!signalPosixGroup(child, "SIGKILL", (cause) => resolve({ ok: !cause, cause }))) resolve({ ok: false });
	});
}

function killFailure(cause?: unknown) {
	const reason = cause instanceof Error ? formatProcessOutput(appendCapped("", cause.message)) : "";
	const details = reason ? ` (${reason})` : "";
	return new Error(`Micme could not send SIGKILL${details}; the child process may still be running.`, { cause });
}

async function waitAfterFailedKill(child: ChildProcess, exitPromise: Promise<ExitResult>, failure: Error) {
	// A real exit can win the race, but the wrapper's result alone cannot
	// excuse a failed kill while the owned tree is still running.
	const exit = await waitForTreeGrace(child, exitPromise, FAILED_KILL_CLOSE_GRACE_MS);
	if (exit) return exit;
	throw failure;
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

async function waitForFinalClose(child: ChildProcess, exitPromise: Promise<ExitResult>, getExit: () => ExitResult): Promise<ExitResult> {
	// The POSIX supervisor performs the final kill itself. Keep IPC open for it
	// even if the wrapper result was already delivered and the pipes were closed.
	const closed = isPosixLauncherRunning(child)
		? Promise.all([exitPromise, new Promise<void>((resolve) => child.once("exit", () => resolve()))]).then(([exit]) => exit)
		: exitPromise;
	const exit = await raceWithTimeout(closed, PROCESS_PIPE_DRAIN_MS);
	if (exit) return exit;
	const result = getExit();

	abandonProcessPipes(child);
	// An IPC write only queues SIGKILL. A live launcher has not completed
	// the group kill, even if the original hook and all its pipes are gone.
	if (isPosixLauncherRunning(child)) throw new Error("Micme could not confirm SIGKILL; the child process may still be running.");
	return result;
}

function isPosixLauncherRunning(child: ChildProcess) {
	return !HOST_IS_WINDOWS && child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

// An external worker can hold inherited descriptors past either drain deadline.
function abandonProcessPipes(child: ChildProcess) {
	child.stdin?.destroy();
	child.stdout?.destroy();
	child.stderr?.destroy();
	child.channel?.unref();
	child.unref();
}

export function sendStopInput(active: OwnedProcess) {
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

	const audioSize = active.directory ? getOwnedRecordingSize(active.audioPath, active.directory) : (await stat(active.audioPath).catch(() => undefined))?.size ?? 0;
	if (audioSize < MIN_AUDIO_BYTES) {
		const stderr = formatProcessOutput(active.stderr());
		const suffix = stderr ? `\nRecorder output:\n${stderr}` : "";
		throw new Error(`Micme recorder did not produce usable audio.${suffix}`);
	}
}

function getOwnedRecordingSize(path: string, directory: RecordingDirectory) {
	try {
		const fd = directory.openFile(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
		try {
			return fstatSync(fd).size;
		} finally {
			closeSync(fd);
		}
	} catch {
		return 0;
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
	cwdFd?: number;
};

export function runProcess(command: string, args: string[], timeoutMs: number, options: RunProcessOptions = {}): Promise<RunResult> {
	return runCommand({ command, args }, timeoutMs, options);
}

function cancelledRun(): RunResult {
	return { code: null, signal: null, stdout: "", stdoutTruncated: false, stderr: "", timedOut: false, cancelled: true };
}

async function runCommand(spec: SpawnSpec, timeoutMs: number, options: RunProcessOptions): Promise<RunResult> {
	if (options.signal?.aborted) return cancelledRun();

	const child = spawnOwnedProcess(spec, false, false, options.cwdFd);
	const { exitPromise, getExit } = observeProcessClose(child);
	let stdout = "";
	let stdoutTruncated = false;
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdoutTruncated ||= stdout.length + chunk.length > MAX_CAPTURED_OUTPUT_CHARS;
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
	return { code: exit.code, signal: exit.signal, stdout, stdoutTruncated, stderr, timedOut, ...(cancelled ? { cancelled: true } : {}) };
}

async function stopInterruptedRun(child: ChildProcess, exitPromise: Promise<ExitResult>, getExit: () => ExitResult, cancelled: boolean) {
	if (cancelled && signalPosixGroup(child, "SIGTERM")) {
		await waitForTreeGrace(child, exitPromise, PROCESS_TERM_GRACE_MS);
	}
	// Even if the snapshot looked empty, end an interrupted run through the
	// identity-safe supervisor rather than releasing a possibly live group.
	const forced = await forceKillTree(child);
	if (forced instanceof Error) return waitAfterFailedKill(child, exitPromise, forced);
	const exit = await waitForFinalClose(child, exitPromise, getExit);
	// A wrapper may have exited with code 0 while the owned hook was still running.
	return exit.code === 0 ? { ...exit, code: null } : exit;
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

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
	return { promise, resolve, reject };
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
