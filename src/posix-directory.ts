import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync, statSync, type BigIntStats } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getSystemErrorName } from "node:util";
import { posixNodeExecutable } from "./posix-node.ts";

const requireNative = createRequire(import.meta.url);
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const USE_PROC_FD = process.platform === "linux";
const DARWIN = process.platform === "darwin";
const O_CLOEXEC = DARWIN ? 0x1000000 : 0x80000;
const AT_REMOVEDIR = DARWIN ? 0x80 : 0x200;
const NUL = Buffer.alloc(1);
let api: ReturnType<typeof loadPosixApi> | undefined;

type DirectoryScan = { matched: boolean; children: [name: string, identity: string][] };

function loadPosixApi() {
	const koffi: typeof import("koffi") = requireNative("koffi");
	const libc = koffi.load(null);
	return {
		errno: koffi.errno,
		openat: libc.func("int openat(int, const void *, int, ...)"),
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
const { lstatSync, readdirSync, rmSync } = require("node:fs");
enterDirectory(process.argv[1], 3);
if (process.argv[2] === "list") {
	const entries = readdirSync(".", { withFileTypes: true });
	process.stdout.write(JSON.stringify(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)));
} else if (process.argv[2] === "scan") {
	const children = [];
	let matched = false;
	for (const name of readdirSync(".", { encoding: "buffer" })) {
		const entry = lstatSync(name, { bigint: true });
		const id = entry.dev + ":" + entry.ino;
		if (entry.isFile() && id === process.argv[3]) { matched = true; break; }
		if (entry.isDirectory()) children.push([name.toString("base64"), id]);
	}
	process.stdout.write(JSON.stringify({ matched, children }));
} else {
	for (const name of readdirSync(".", { encoding: "buffer" })) rmSync(name, { recursive: true, force: true });
}
`;

function directoryTask(fd: number, action: "list" | "clear" | "scan", identity = "") {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(posixNodeExecutable(), ["--input-type=commonjs", "-e", DIRECTORY_TASK_SOURCE, posixDirectoryLibrary(), action, identity], {
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

export function posixFileIdentity(stats: BigIntStats) {
	return `${stats.dev}:${stats.ino}`;
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

	openFile(name: string | Buffer, flags: number, mode?: number) {
		if (this.procPath) {
			const path = typeof name === "string" ? join(this.procPath, name) : Buffer.concat([Buffer.from(`${this.procPath}/`), name]);
			return openSync(path, flags, mode);
		}
		api ??= loadPosixApi();
		const path = typeof name === "string" ? Buffer.from(`${name}\0`) : Buffer.concat([name, NUL]);
		const nativeFlags = flags | O_CLOEXEC;
		const fd = mode === undefined ? api.openat(this.fd, path, nativeFlags) : api.openat(this.fd, path, nativeFlags, "uint32_t", mode);
		return checked(fd, name.toString());
	}

	openDirectory(name: string | Buffer) {
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

	containsFile(identity: string): Promise<boolean> {
		return this.findFile(identity, new Set());
	}

	private async findFile(identity: string, ancestors: Set<string>): Promise<boolean> {
		const here = posixFileIdentity(this.identity);
		if (ancestors.has(here)) throw new Error("Micme refused to inspect a cyclic recording directory tree.");
		ancestors.add(here);
		try {
			const { matched, children } = await this.scanEntries(identity);
			if (matched) return true;
			for (const [encodedName, expected] of children) {
				const name = Buffer.from(encodedName, "base64");
				const child = this.openScannedDirectory(name, expected);
				try {
					const found = await child.findFile(identity, ancestors);
					// The scan used a held descriptor. Recheck that its name still reaches
					// it before trusting either a match or an absence in the owned tree.
					this.openScannedDirectory(name, expected).close();
					if (found) return true;
				} finally {
					child.close();
				}
			}
			return false;
		} finally {
			ancestors.delete(here);
		}
	}

	private openScannedDirectory(name: Buffer, expected: string) {
		// Only one byte-preserving entry name from readdir is resolved at a time.
		// O_NOFOLLOW and O_DIRECTORY stop a replacement link before descent.
		const child = this.openDirectory(name);
		if (posixFileIdentity(child.identity) === expected && child.identity.dev === this.identity.dev) return child;
		child.close();
		throw new Error("Micme refused to inspect a recording subdirectory whose identity or device changed.");
	}

	private async scanEntries(identity: string): Promise<DirectoryScan> {
		if (!this.procPath) return JSON.parse(await directoryTask(this.fd, "scan", identity)) as DirectoryScan;
		const prefix = Buffer.from(`${this.procPath}/`);
		const children: DirectoryScan["children"] = [];
		for (const name of await readdir(this.procPath, { encoding: "buffer" })) {
			const entry = lstatSync(Buffer.concat([prefix, name]), { bigint: true });
			const id = posixFileIdentity(entry);
			if (entry.isFile() && id === identity) return { matched: true, children };
			if (entry.isDirectory()) children.push([name.toString("base64"), id]);
		}
		return { matched: false, children };
	}

	isAt(path: string) {
		const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
		return Boolean(entry?.isDirectory() && entry.dev === this.identity.dev && entry.ino === this.identity.ino);
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
