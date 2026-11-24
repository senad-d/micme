import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ExitResult } from "./types.ts";

// A detached launcher is the session and group leader. Only it signals its own
// group (kill(0, ...)), even after the hook exits. The parent never signals a PGID.
const LAUNCHER = String.raw`
const { spawn } = require("node:child_process");
const { closeSync } = require("node:fs");
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
process.on("disconnect", () => process.exit(0));
function report(result) {
	if (process.connected) process.send(result, () => {});
}
function reportError({ message, code, errno, syscall, path, spawnargs }) {
	report({ error: { message, code, errno, syscall, path, spawnargs } });
}
function launch({ command, args, pipeInput }) {
	try {
		const child = spawn(command, args, { stdio: [pipeInput ? 0 : "ignore", 1, 2] });
		if (child.pid) report({ pid: child.pid });
		child.once("error", reportError);
		child.once("exit", (code, signal) => report({ code, signal }));
	} catch (error) {
		reportError(error);
	} finally {
		if (pipeInput) closeSync(0);
		closeSync(1);
		closeSync(2);
	}
}
process.on("message", (message) => {
	if (typeof message === "string") process.kill(0, message);
	else launch(message);
});
`;

const supervisors = new WeakSet<ChildProcess>();
const hookPids = new WeakMap<ChildProcess, number>();

export function spawnPosixGroupProcess(command: string, args: string[], pipeInput: boolean) {
	const child = spawn(process.execPath, ["--input-type=commonjs", "-e", LAUNCHER], {
		detached: true,
		stdio: [pipeInput ? "pipe" : "ignore", "pipe", "pipe", "ipc"],
	});
	if (child.pid) {
		supervisors.add(child);
		child.send({ command, args, pipeInput }, () => undefined);
	}
	return child;
}

export function observePosixGroupClose(child: ChildProcess, settle: (exit: ExitResult) => void) {
	let hookExit: ExitResult | undefined;
	let pendingPipes = 0;
	const finish = () => {
		if (!hookExit || pendingPipes !== 0) return;
		child.channel?.unref();
		child.unref();
		settle(hookExit);
	};
	for (const pipe of [child.stdout, child.stderr]) {
		if (!pipe) continue;
		pendingPipes++;
		pipe.once("close", () => {
			pendingPipes--;
			finish();
		});
	}
	child.on("message", ({ code, signal, error, pid }: ExitResult & { pid?: number }) => {
		if (pid) hookPids.set(child, pid);
		else if (error) settle({ code: null, signal: null, error: Object.assign(new Error(error.message), error) });
		else {
			hookExit = { code, signal };
			finish();
		}
	});
	child.once("exit", (code, signal) => {
		hookExit ??= { code, signal };
		finish();
	});
	return () => hookExit ?? { code: child.exitCode, signal: child.signalCode };
}

export function signalPosixGroup(child: ChildProcess, signal: NodeJS.Signals) {
	if (!supervisors.has(child) || !child.connected) return false;
	child.send(signal, () => undefined);
	return true;
}

export async function posixRecorderState(child: ChildProcess) {
	const pid = hookPids.get(child);
	if (!pid) return "running";
	// The wrapper can already be dead while its exit report is still in transit.
	const workers = await readGroupWorkers(child, 200);
	if (!workers || workers.includes(pid)) return "running";
	return workers.length ? "workers" : "exited";
}

export async function posixGroupHasWorkers(child: ChildProcess, remainingMs: number) {
	const workers = await readGroupWorkers(child, remainingMs);
	return workers === undefined || workers.length !== 0;
}

// A snapshot informs grace and exit reporting, never the destination of a signal.
function readGroupWorkers(child: ChildProcess, remainingMs: number) {
	if (!supervisors.has(child) || !child.connected) return Promise.resolve([]);
	return new Promise<number[] | undefined>((resolve) => {
		execFile("/bin/ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="], {
			encoding: "utf8", timeout: Math.max(1, Math.floor(Math.min(remainingMs, 200))), killSignal: "SIGKILL",
		}, (error, output) => {
			if (error) return resolve(undefined); // Unknown: allow the rest of the grace period.
			const workers = [];
			for (const line of output.split("\n")) {
				const [rawPid, group, state] = line.trim().split(/\s+/);
				const pid = Number(rawPid);
				if (Number(group) === child.pid && pid !== child.pid && !state?.startsWith("Z")) workers.push(pid);
			}
			resolve(workers);
		});
	});
}

export function releasePosixGroup(child: ChildProcess) {
	if (supervisors.delete(child) && child.connected) child.disconnect();
}
