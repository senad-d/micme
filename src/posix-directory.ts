import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, rmdirSync, statSync, type BigIntStats } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getSystemErrorName } from "node:util";

const requireNative = createRequire(import.meta.url);
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const USE_PROC_FD = process.platform === "linux";
const DARWIN = process.platform === "darwin";
const O_CLOEXEC = DARWIN ? 0x1000000 : 0x80000;
const AT_REMOVEDIR = DARWIN ? 0x80 : 0x200;
let api: ReturnType<typeof loadPosixApi> | undefined;

function loadPosixApi() {
	const koffi: typeof import("koffi") = requireNative("koffi");
	const libc = koffi.load(null);
	return {
		errno: koffi.errno,
		openat: libc.func("int openat(int, const char *, int, ...)"),
		mkdirat: libc.func("int mkdirat(int, const char *, uint32_t)"),
		renameat: libc.func("int renameat(int, const char *, int, const char *)"),
		unlinkat: libc.func("int unlinkat(int, const char *, int)"),
	};
}

function checked(result: number, name: string) {
	if (result !== -1) return result;
	const code = getSystemErrorName(-api!.errno());
	throw Object.assign(new Error(`${code}: Micme could not access directory entry ${name}`), { code });
}

export function posixDirectoryLibrary() {
	return requireNative.resolve("koffi");
}

// Darwin's /dev/fd does not support traversal through directory descriptors.
// Change cwd only in a dedicated subprocess, never in Pi or its worker threads.
export const FCHDIR_SOURCE = `
function enterDirectory(library, fd) {
	const koffi = require(library);
	// Keep the library reference alive for the duration of the native call.
	const libc = koffi.load(null);
	if (libc.func("int fchdir(int)")(fd) === -1) throw new Error("Micme could not enter its recording directory");
	require("node:fs").closeSync(fd);
}
`;

const DIRECTORY_TASK_SOURCE = FCHDIR_SOURCE + `
const { readdirSync, rmSync } = require("node:fs");
enterDirectory(process.argv[1], 3);
if (process.argv[2] === "list") {
	const entries = readdirSync(".", { withFileTypes: true });
	process.stdout.write(JSON.stringify(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)));
} else {
	for (const name of readdirSync(".", { encoding: "buffer" })) rmSync(name, { recursive: true, force: true });
}
`;

function directoryTask(fd: number, action: "list" | "clear") {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=commonjs", "-e", DIRECTORY_TASK_SOURCE, posixDirectoryLibrary(), action], {
			stdio: ["ignore", "pipe", "pipe", fd],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`Micme could not ${action} its recording directory: ${stderr.trim()}`));
		});
	});
}

function verifiedProcPath(fd: number, identity: BigIntStats) {
	const path = `/proc/${process.pid}/fd/${fd}`;
	try {
		const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
		if (stats?.ino === identity.ino && stats.dev === identity.dev) return path;
	} catch {
		// A restricted procfs is as unusable as a missing one. Keep using the descriptor.
	}
	return undefined;
}

export class PosixDirectory {
	readonly fd: number;
	readonly identity: BigIntStats;
	readonly procPath: string | undefined;

	constructor(fd: number, useProc: boolean) {
		this.fd = fd;
		try {
			this.identity = fstatSync(fd, { bigint: true });
			if (useProc) this.procPath = verifiedProcPath(fd, this.identity);
		} catch (error) {
			closeSync(fd);
			throw error;
		}
	}

	static openProject(path: string) {
		// The project itself is the starting point selected by Pi. From here on,
		// resolve each child against this open directory, not against its name.
		const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
		return new PosixDirectory(fd, USE_PROC_FD);
	}

	openFile(name: string, flags: number, mode?: number) {
		if (this.procPath) return openSync(join(this.procPath, name), flags, mode);
		api ??= loadPosixApi();
		const nativeFlags = flags | O_CLOEXEC;
		const fd = mode === undefined ? api.openat(this.fd, name, nativeFlags) : api.openat(this.fd, name, nativeFlags, "uint32_t", mode);
		return checked(fd, name);
	}

	openDirectory(name: string) {
		return new PosixDirectory(this.openFile(name, DIRECTORY_FLAGS), this.procPath !== undefined);
	}

	mkdir(name: string, mode: number) {
		if (this.procPath) return mkdirSync(join(this.procPath, name), { mode });
		api ??= loadPosixApi();
		checked(api.mkdirat(this.fd, name, mode), name);
	}

	async listDirectories(): Promise<string[]> {
		if (!this.procPath) return JSON.parse(await directoryTask(this.fd, "list")) as string[];
		const entries = await readdir(this.procPath, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	}

	move(name: string, target: PosixDirectory, targetName: string) {
		if (this.procPath && target.procPath) return renameSync(join(this.procPath, name), join(target.procPath, targetName));
		api ??= loadPosixApi();
		checked(api.renameat(this.fd, name, target.fd, targetName), name);
	}

	async clear() {
		if (!this.procPath) {
			await directoryTask(this.fd, "clear");
			return;
		}
		// POSIX entry names are bytes; decoding to UTF-8 can change the name we remove.
		// Bound recursive removals to one subtree at a time and stop on the first failure.
		const prefix = Buffer.from(`${this.procPath}/`);
		for (const name of await readdir(this.procPath, { encoding: "buffer" })) {
			await rm(Buffer.concat([prefix, name]), { recursive: true, force: true });
		}
	}

	rmdir(name: string) {
		if (this.procPath) return rmdirSync(join(this.procPath, name));
		api ??= loadPosixApi();
		checked(api.unlinkat(this.fd, name, AT_REMOVEDIR), name);
	}

	close() {
		closeSync(this.fd);
	}
}
