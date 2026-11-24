import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PosixDirectory } from "./posix-directory.ts";
import { cleanup } from "./processes.ts";
import { WindowsRecordingDirectory } from "./windows-recording-dir.ts";

const HOST_PLATFORM = process.platform;
const PROJECT_RECORDINGS_DIR = "micme-rec";
const RECORDING_DIR_PREFIX = "rec-";
const MAX_SEQUENTIAL_RECORDING_DIRS = 999_999;
const PRIVATE_DIRECTORY_MODE = 0o700;

type DirectoryAccess = {
	filesPath: string;
	cwdFd?: number;
	openFile?: (name: string, flags: number) => number;
	remove: () => Promise<void>;
	close: () => void;
};

export class RecordingDirectory {
	private removal?: Promise<void>;
	private closed = false;
	readonly path: string;
	private readonly access?: DirectoryAccess;

	constructor(path: string, access?: DirectoryAccess) {
		this.path = path;
		this.access = access;
	}

	get filesPath() { return this.access?.filesPath ?? this.path; }
	get cwdFd() { return this.access?.cwdFd; }

	openFile(path: string, flags: number) {
		if (this.closed) throw new Error("Micme's recording directory has been closed.");
		return this.access?.openFile ? this.access.openFile(basename(path), flags) : openSync(path, flags);
	}

	hasRegularFile(path: string, minBytes = 0) {
		if (this.closed) throw new Error("Micme's recording directory has been closed.");
		if (this.cwdFd === undefined) {
			const entry = lstatSync(join(this.filesPath, basename(path)), { throwIfNoEntry: false });
			return entry !== undefined && entry.isFile() && entry.size >= minBytes;
		}

		// When there is no usable path to the held directory, check via openat.
		try {
			const fd = this.openFile(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
			try {
				const entry = fstatSync(fd);
				return entry.isFile() && entry.size >= minBytes;
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP")) return false;
			throw error;
		}
	}

	async remove() {
		if (this.removal) return this.removal;
		if (this.closed) throw new Error("Micme's recording directory has been closed.");
		this.removal = this.access?.remove() ?? cleanup(this.path);
		return this.removal;
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.access?.close();
	}
}

export async function createRecordingDirectory(cwd: string, keepAudio: boolean, tempPrefix = "micme-") {
	if (!keepAudio) return new RecordingDirectory(await mkdtemp(join(tmpdir(), tempPrefix)));
	return createProjectRecordingDirectory(cwd);
}

export async function createProjectRecordingDirectory(cwd: string) {
	const recordingsRoot = join(cwd, PROJECT_RECORDINGS_DIR);
	if (HOST_PLATFORM === "win32") return createWindowsRecordingDirectory(cwd, recordingsRoot);
	if (HOST_PLATFORM === "linux" || HOST_PLATFORM === "darwin") return createPosixRecordingDirectory(cwd, recordingsRoot);
	throw new Error(`Micme cannot safely keep audio in a project directory on ${HOST_PLATFORM}.`);
}

async function createPosixRecordingDirectory(cwd: string, recordingsRoot: string) {
	const project = PosixDirectory.openProject(cwd);
	let root: PosixDirectory;
	try {
		try {
			project.mkdir(PROJECT_RECORDINGS_DIR, PRIVATE_DIRECTORY_MODE);
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		try {
			root = project.openDirectory(PROJECT_RECORDINGS_DIR);
		} catch (error) {
			if (!hasCode(error, "ENOTDIR") && !hasCode(error, "ELOOP")) throw error;
			throw new Error(`Refusing to use a symbolic-link recordings directory or non-directory: ${recordingsRoot}`, { cause: error });
		}
	} finally {
		project.close();
	}

	try {
		const name = await allocateLeaf(root, recordingsRoot);
		const leaf = root.openDirectory(name);
		return new RecordingDirectory(join(recordingsRoot, name), {
			filesPath: leaf.procPath ?? ".",
			cwdFd: leaf.procPath ? undefined : leaf.fd,
			openFile: leaf.openFile.bind(leaf),
			remove: () => removePosixRecording(root, name, leaf),
			close: () => closePosixRecording(root, leaf),
		});
	} catch (error) {
		root.close();
		throw error;
	}
}

function closePosixRecording(root: PosixDirectory, leaf: PosixDirectory) {
	try {
		leaf.close();
	} finally {
		root.close();
	}
}

function verifyLeaf(parent: PosixDirectory, name: string, expected: PosixDirectory) {
	const found = parent.openDirectory(name);
	try {
		if (found.identity.ino === expected.identity.ino && found.identity.dev === expected.identity.dev) return;
		throw new Error(`Micme refused to remove a recording directory whose identity changed: ${name}`);
	} finally {
		found.close();
	}
}

async function removePosixRecording(root: PosixDirectory, name: string, leaf: PosixDirectory) {
	verifyLeaf(root, name, leaf);
	// Any content removal goes through the held leaf, never the public name.
	await leaf.clear();
	verifyLeaf(root, name, leaf);
	// Claim the empty entry privately, then verify what the rename moved
	// before removing it. A replacement is never recursively removed.
	const holdingName = `.micme-cleanup-${randomUUID()}`;
	root.mkdir(holdingName, PRIVATE_DIRECTORY_MODE);
	const holding = root.openDirectory(holdingName);
	try {
		root.move(name, holding, "recording");
		verifyLeaf(holding, "recording", leaf);
		holding.rmdir("recording");
		verifyLeaf(root, holdingName, holding);
		root.rmdir(holdingName);
	} finally {
		holding.close();
	}
}

async function createWindowsRecordingDirectory(cwd: string, recordingsRoot: string) {
	const project = await WindowsRecordingDirectory.openProject(cwd);
	try {
		try {
			await project.mkdir(PROJECT_RECORDINGS_DIR, PRIVATE_DIRECTORY_MODE);
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		const root = project.openDirectory(PROJECT_RECORDINGS_DIR);
		try {
			const name = await allocateLeaf(root, recordingsRoot);
			const leaf = root.openDirectory(name);
			return new RecordingDirectory(join(recordingsRoot, name), {
				filesPath: leaf.path,
				remove: leaf.remove.bind(leaf),
				close: leaf.close.bind(leaf),
			});
		} catch (error) {
			root.close();
			throw error;
		}
	} catch (error) {
		project.close();
		throw error;
	}
}

async function allocateLeaf(root: PosixDirectory | WindowsRecordingDirectory, recordingsRoot: string) {
	const nextIndex = getNextRecordingIndex(await root.listDirectories());
	for (let index = nextIndex; index <= MAX_SEQUENTIAL_RECORDING_DIRS; index += 1) {
		const name = formatRecordingDirectoryName(index);
		try {
			await root.mkdir(name, PRIVATE_DIRECTORY_MODE);
			return name;
		} catch (error) {
			if (hasCode(error, "EEXIST")) continue;
			throw error;
		}
	}
	throw new Error(`Unable to create a Micme recording directory under ${recordingsRoot}.`);
}

function getNextRecordingIndex(directories: string[]) {
	let maxIndex = 0;
	for (const name of directories) {
		const match = /^rec-(\d+)$/.exec(name);
		if (!match) continue;
		const index = Number(match[1]);
		if (Number.isInteger(index) && index <= MAX_SEQUENTIAL_RECORDING_DIRS && index > maxIndex) maxIndex = index;
	}
	return maxIndex + 1;
}

export function formatRecordingDirectoryName(index: number) {
	const safeIndex = Math.max(1, Math.trunc(index));
	const text = String(safeIndex);
	return `${RECORDING_DIR_PREFIX}${text.padStart(Math.max(3, text.length), "0")}`;
}

function hasCode(error: unknown, code: string) {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
