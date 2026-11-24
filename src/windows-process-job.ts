import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { CommandSpec } from "./types.ts";

// The launcher waits for IPC so nothing from the hook can run before job assignment.
// The hook inherits Micme's pipes directly, including the recorder's graceful stdin.
const LAUNCHER = `
const { spawn } = require("node:child_process");
function reportError(error) {
	const { message, code, errno, syscall, path, spawnargs } = error;
	process.send({ message, code, errno, syscall, path, spawnargs }, () => process.exit(1));
}
process.once("message", ({ command, args, pipeInput, spawnOptions }) => {
	try {
		const child = spawn(command, args, { ...spawnOptions, stdio: [pipeInput ? 0 : "ignore", 1, 2], windowsHide: true });
		child.once("error", reportError);
		child.once("exit", (code) => process.exit(code ?? 1));
	} catch (error) {
		reportError(error);
	}
});
`;

// Distinguish forced termination from an ordinary hook error racing with stop.
export const WINDOWS_JOB_STOP_EXIT_CODE = 0x4d49434d; // "MICM"

const loadNative = createRequire(import.meta.url);
const jobs = new WeakMap<ChildProcess, WindowsProcessJob>();
let windowsApi: ReturnType<typeof loadWindowsApi> | undefined;

function loadWindowsApi() {
	const koffi: typeof import("koffi") = loadNative("koffi");
	const kernel32 = koffi.load("kernel32.dll");
	const basicLimits = koffi.struct({
		perProcessTime: "int64_t",
		perJobTime: "int64_t",
		flags: "uint32_t",
		minWorkingSet: "size_t",
		maxWorkingSet: "size_t",
		activeProcessLimit: "uint32_t",
		affinity: "uintptr_t",
		priorityClass: "uint32_t",
		schedulingClass: "uint32_t",
	});
	const extendedLimits = koffi.struct({
		basicLimits,
		ioCounters: koffi.array("uint64_t", 6),
		memoryLimitsAndPeaks: koffi.array("size_t", 4),
	});
	const killOnClose = Buffer.alloc(koffi.sizeof(extendedLimits));
	killOnClose.writeUInt32LE(0x2000, koffi.offsetof(basicLimits, "flags")); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	return {
		killOnClose,
		create: kernel32.func("void * __stdcall CreateJobObjectW(void *, void *)"),
		setInformation: kernel32.func("int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)"),
		queryInformation: kernel32.func("int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)"),
		openProcess: kernel32.func("void * __stdcall OpenProcess(uint32_t, int, uint32_t)"),
		assign: kernel32.func("int __stdcall AssignProcessToJobObject(void *, void *)"),
		terminate: kernel32.func("int __stdcall TerminateJobObject(void *, uint32_t)"),
		close: kernel32.func("int __stdcall CloseHandle(void *)"),
	};
}

class WindowsProcessJob {
	private readonly api: ReturnType<typeof loadWindowsApi>;
	private handle: bigint | null;

	constructor(terminateOnClose: boolean) {
		windowsApi ??= loadWindowsApi();
		this.api = windowsApi;
		this.handle = this.api.create(null, null);
		if (!this.handle) throw new Error("Could not create a Windows job for the Micme process.");
		// Bounded runs release their job on normal completion without killing
		// background workers. Only their explicit interruption terminates the job.
		if (!terminateOnClose) return;
		const { killOnClose } = this.api;
		// JobObjectExtendedLimitInformation
		if (this.api.setInformation(this.handle, 9, killOnClose, killOnClose.length)) return;
		this.close();
		throw new Error("Could not set cleanup limits on the Windows job for the Micme process.");
	}

	assign(pid: number) {
		// PROCESS_SET_QUOTA | PROCESS_TERMINATE
		const processHandle = this.api.openProcess(0x101, 0, pid);
		if (!processHandle) throw new Error("Could not open the Micme launcher for Windows job assignment.");
		try {
			if (!this.api.assign(this.handle, processHandle)) throw new Error("Could not assign the Micme launcher to its Windows job.");
		} finally {
			this.api.close(processHandle);
		}
	}

	hasProcesses() {
		if (!this.handle) return false;
		// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: four LARGE_INTEGERs, then
		// four DWORDs. ActiveProcesses is the third DWORD.
		const accounting = Buffer.alloc(48);
		return !this.api.queryInformation(this.handle, 1, accounting, accounting.length, null) || accounting.readUInt32LE(40) !== 0;
	}

	terminate() {
		return Boolean(this.handle && this.api.terminate(this.handle, WINDOWS_JOB_STOP_EXIT_CODE));
	}

	close() {
		if (this.handle) this.api.close(this.handle);
		this.handle = null;
	}
}

export class WindowsHookLaunchError extends Error {}

export function spawnWindowsJobProcess(command: string, args: string[], pipeInput: boolean, retainUntilStop: boolean, spawnOptions?: CommandSpec["spawnOptions"]) {
	const job = new WindowsProcessJob(retainUntilStop);
	let launcher: ChildProcess | undefined;
	try {
		launcher = spawn(process.execPath, ["--input-type=commonjs", "-e", LAUNCHER], {
			stdio: [pipeInput ? "pipe" : "ignore", "pipe", "pipe", "ipc"],
			windowsHide: true,
		});
		if (!launcher.pid) {
			job.close();
			return launcher;
		}
		job.assign(launcher.pid);
	} catch (error) {
		job.close();
		launcher?.on("error", () => undefined);
		if (launcher?.connected) launcher.disconnect();
		throw error;
	}

	const child = launcher;
	jobs.set(child, job);
	const reportLaunchError = (error: NodeJS.ErrnoException) => child.emit("error", Object.assign(new WindowsHookLaunchError(error.message), error));
	child.on("message", reportLaunchError);
	child.send({ command, args, pipeInput, spawnOptions }, (error) => {
		// Forced job termination can close IPC before the launcher reads this.
		if (error && jobs.has(child)) reportLaunchError(error);
	});
	return child;
}

export function windowsJobHasProcesses(child: ChildProcess) {
	const job = jobs.get(child);
	if (!job) return false;
	if (job.hasProcesses()) return true;
	// A descendant can be the last to exit, after the launcher's close event.
	closeWindowsJob(child);
	return false;
}

export function terminateWindowsJob(child: ChildProcess) {
	const job = jobs.get(child);
	// After a failed termination the caller still needs the job to tell a
	// real tree exit from a wrapper that left live workers behind.
	if (!job?.terminate()) return false;
	closeWindowsJob(child);
	return true;
}

export function closeWindowsJob(child: ChildProcess) {
	jobs.get(child)?.close();
	jobs.delete(child);
}
