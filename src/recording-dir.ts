import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, read, unlinkSync, type BigIntStats } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { posixFileIdentity, PosixDirectory } from "./posix-directory.ts";
import { cleanup } from "./processes.ts";
import { WindowsRecordingDirectory } from "./windows-recording-dir.ts";

const HOST_PLATFORM = process.platform;
const PROJECT_RECORDINGS_DIR = "micme-rec";
const RECORDING_DIR_PREFIX = "rec-";
const MAX_SEQUENTIAL_RECORDING_DIRS = 999_999;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const EXCLUSIVE_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
const readAt = promisify(read);

export interface VerifiedRecordingFile {
	identity(): string;
	/** Reject ambiguous hard links and detect writes/truncation during a stopped snapshot. */
	snapshotStamp(): string;
	size(): number;
	readAt(bytes: Buffer, offset: number): Promise<number>;
	close(): void;
}

type DirectoryAccess = {
	filesPath: string;
	cwdFd?: number;
	openFile?: (name: string, flags: number) => number;
	openVerifiedFile: (name: string) => VerifiedRecordingFile | undefined;
	containsFile: (identity: string) => Promise<boolean>;
	verifiedDisplayPath: () => string | undefined;
	createPrivateFile: (name: string) => number;
	matchesPrivateFile: (name: string, expected: BigIntStats) => boolean;
	unlinkPrivateFile: (name: string) => void;
	remove: () => Promise<void>;
	close: () => void;
};

export class RecordingDirectory {
	private removal?: Promise<void>;
	private closed = false;
	private heldClip?: { name: string; file: VerifiedRecordingFile };
	private readonly transientFiles = new Map<string, BigIntStats>();
	readonly path: string;
	private readonly access?: DirectoryAccess;

	constructor(path: string, access?: DirectoryAccess) {
		this.path = path;
		this.access = access;
	}

	get filesPath() { return this.access?.filesPath ?? this.path; }
	get cwdFd() { return this.access?.cwdFd; }

	liveFilePath(path: string) {
		return join(this.liveAccess().filesPath, recordingFileName(path));
	}

	openVerifiedFile(path: string) {
		return this.liveAccess().openVerifiedFile(recordingFileName(path));
	}

	/** A clip can first open after stop (e.g. a close-only hook). Never replace a held source. */
	holdClipFile(path: string) {
		const { openVerifiedFile } = this.liveAccess();
		const name = recordingFileName(path);
		if (this.heldClip) {
			if (this.heldClip.name !== name) throw new Error("Micme already holds a different clip recording file.");
			return this.heldClip.file;
		}
		const file = openVerifiedFile(name);
		if (file) this.heldClip = { name, file };
		return file;
	}

	/** An exact leaf check differs from retention, which may find audio moved into a subtree. */
	matchesVerifiedFile(path: string, file: VerifiedRecordingFile) {
		const entry = this.openVerifiedFile(path);
		if (!entry) return false;
		try {
			return entry.identity() === file.identity();
		} finally {
			entry.close();
		}
	}

	containsVerifiedFile(file: VerifiedRecordingFile) {
		return this.liveAccess().containsFile(file.identity());
	}

	verifiedDisplayPath() {
		return this.liveAccess().verifiedDisplayPath();
	}

	createPrivateFile(path: string) {
		return this.liveAccess().createPrivateFile(recordingFileName(path));
	}

	matchesPrivateFile(path: string, expected: BigIntStats) {
		return this.liveAccess().matchesPrivateFile(recordingFileName(path), expected);
	}

	discardPrivateFile(path: string, expected: BigIntStats) {
		if (this.matchesPrivateFile(path, expected)) this.liveAccess().unlinkPrivateFile(recordingFileName(path));
	}

	/** A snapshot staged alongside retained raw audio belongs only to the open take. */
	discardPrivateFileOnClose(path: string, expected: BigIntStats) {
		this.liveAccess();
		this.transientFiles.set(recordingFileName(path), expected);
	}

	private liveAccess() {
		if (this.closed || !this.access) throw new Error("Micme requires an open, verified recording directory for live capture. Check the recording setup or use clip mode.");
		return this.access;
	}

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
		this.closeClipFile();
		this.removal = this.access?.remove() ?? cleanup(this.path);
		return this.removal;
	}

	close() {
		if (this.closed) return;
		try {
			if (!this.removal) {
				for (const [name, expected] of this.transientFiles) {
					try {
						this.discardPrivateFile(name, expected);
					} catch {
						// Best effort only: do not delete an unverifiable file or strand the directory handle.
					}
				}
			}
			this.closeClipFile();
		} finally {
			this.closed = true;
			this.transientFiles.clear();
			this.access?.close();
		}
	}

	private closeClipFile() {
		const held = this.heldClip;
		this.heldClip = undefined;
		held?.file.close();
	}
}

export async function createRecordingDirectory(cwd: string, keepAudio: boolean, tempPrefix = "micme-") {
	if (!keepAudio) return new RecordingDirectory(await mkdtemp(join(tmpdir(), tempPrefix)));
	return createProjectRecordingDirectory(cwd);
}

/** Observe and freeze mic clips through a held directory without requiring that of an opaque hook on other hosts. */
export function createClipRecordingDirectory(cwd: string, keepAudio: boolean, tempPrefix = "micme-") {
	if (keepAudio) return createProjectRecordingDirectory(cwd);
	if (HOST_PLATFORM === "win32") return createWindowsLiveTempDirectory(tempPrefix);
	if (HOST_PLATFORM === "linux" || HOST_PLATFORM === "darwin") return createPosixLiveTempDirectory(tempPrefix);
	return createRecordingDirectory(cwd, false, tempPrefix);
}

/** Live spools and refinement targets require held directory access even when not kept. */
export async function createLiveRecordingDirectory(cwd: string, keepAudio: boolean, tempPrefix = "micme-") {
	try {
		if (keepAudio) return await createProjectRecordingDirectory(cwd);
		if (HOST_PLATFORM === "win32") return await createWindowsLiveTempDirectory(tempPrefix);
		if (HOST_PLATFORM === "linux" || HOST_PLATFORM === "darwin") return await createPosixLiveTempDirectory(tempPrefix);
		throw new Error(`Verified recording directories are not supported on ${HOST_PLATFORM}.`);
	} catch (error) {
		throw new Error("Micme could not establish a verified directory for live capture. Check the recording directory setup or use clip mode.", { cause: error });
	}
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
		return createPosixLeaf(root, recordingsRoot, name);
	} catch (error) {
		root.close();
		throw error;
	}
}

async function createPosixLiveTempDirectory(prefix: string) {
	const parent = await realpath(tmpdir());
	const root = PosixDirectory.openProject(parent);
	try {
		const name = recordingFileName(`${prefix}${randomUUID()}`);
		root.mkdir(name, PRIVATE_DIRECTORY_MODE);
		return createPosixLeaf(root, parent, name);
	} catch (error) {
		root.close();
		throw error;
	}
}

function createPosixLeaf(root: PosixDirectory, parent: string, name: string) {
	const leaf = root.openDirectory(name);
	const path = join(parent, name);
	return new RecordingDirectory(path, {
		filesPath: leaf.procPath ?? ".",
		cwdFd: leaf.procPath ? undefined : leaf.fd,
		openFile: leaf.openFile.bind(leaf),
		openVerifiedFile: (file) => openVerifiedPosixFile(leaf, file),
		containsFile: leaf.containsFile.bind(leaf),
		verifiedDisplayPath: () => leaf.isAt(path) ? path : undefined,
		createPrivateFile: (file) => leaf.openFile(file, EXCLUSIVE_FILE_FLAGS | constants.O_NOFOLLOW, PRIVATE_FILE_MODE),
		matchesPrivateFile: (file, expected) => matchesPosixPrivateFile(leaf, file, expected),
		unlinkPrivateFile: leaf.unlinkFile.bind(leaf),
		remove: () => removePosixRecording(root, name, leaf),
		close: () => closePosixRecording(root, leaf),
	});
}

function matchesPosixPrivateFile(directory: PosixDirectory, name: string, expected: BigIntStats) {
	let fd: number;
	try {
		fd = directory.openFile(name, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch (error) {
		if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP")) return false;
		throw error;
	}
	try {
		return sameRegularFile(expected, fstatSync(fd, { bigint: true }));
	} finally {
		closeSync(fd);
	}
}

function sameRegularFile(expected: BigIntStats, found: BigIntStats) {
	return found.isFile() && expected.ino === found.ino && expected.dev === found.dev;
}

function openVerifiedPosixFile(directory: PosixDirectory, name: string) {
	let fd: number;
	try {
		fd = directory.openFile(name, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Micme's live recording leaf is not a regular file.");
		return new PosixRecordingFile(fd);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

class PosixRecordingFile implements VerifiedRecordingFile {
	private fd?: number;

	constructor(fd: number) {
		this.fd = fd;
	}

	private descriptor() {
		if (this.fd === undefined) throw new Error("Micme's live recording file is closed.");
		return this.fd;
	}

	identity() {
		return posixFileIdentity(fstatSync(this.descriptor(), { bigint: true }));
	}

	snapshotStamp() {
		const stats = fstatSync(this.descriptor(), { bigint: true });
		if (stats.nlink !== 1n) throw new Error("Micme cannot verify a recording leaf with ambiguous hard links.");
		return `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	}

	size() {
		return fstatSync(this.descriptor()).size;
	}

	async readAt(bytes: Buffer, offset: number) {
		const result = await readAt(this.descriptor(), bytes, 0, bytes.length, offset);
		return result.bytesRead;
	}

	close() {
		if (this.fd === undefined) return;
		const fd = this.fd;
		this.fd = undefined;
		closeSync(fd);
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
			return windowsLeaf(join(recordingsRoot, name), root.openDirectory(name));
		} catch (error) {
			root.close();
			throw error;
		}
	} catch (error) {
		project.close();
		throw error;
	}
}

async function createWindowsLiveTempDirectory(prefix: string) {
	const root = await WindowsRecordingDirectory.openProject(tmpdir());
	try {
		const name = recordingFileName(`${prefix}${randomUUID()}`);
		await root.mkdir(name, PRIVATE_DIRECTORY_MODE);
		const leaf = root.openDirectory(name);
		return windowsLeaf(leaf.path, leaf);
	} catch (error) {
		root.close();
		throw error;
	}
}

function windowsLeaf(path: string, leaf: WindowsRecordingDirectory) {
	return new RecordingDirectory(path, {
		filesPath: leaf.path,
		openVerifiedFile: leaf.openVerifiedFile.bind(leaf),
		containsFile: leaf.containsFile.bind(leaf),
		// Report the locked physical path, not a workspace alias that may have changed.
		verifiedDisplayPath: () => leaf.path,
		// Create a new file exclusively under the locked directory; this is
		// never the path used to read or verify a recorder-created leaf.
		createPrivateFile: (name) => openSync(join(leaf.path, name), EXCLUSIVE_FILE_FLAGS, PRIVATE_FILE_MODE),
		matchesPrivateFile: (name, expected) => matchesWindowsPrivateFile(join(leaf.path, name), expected),
		unlinkPrivateFile: (name) => unlinkSync(join(leaf.path, name)),
		remove: leaf.remove.bind(leaf),
		close: leaf.close.bind(leaf),
	});
}

function matchesWindowsPrivateFile(path: string, expected: BigIntStats) {
	const found = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	return found !== undefined && sameRegularFile(expected, found);
}

function recordingFileName(path: string) {
	const name = basename(path);
	if (!name || name === "." || name === ".." || (HOST_PLATFORM === "win32" && name.includes(":"))) throw new Error("Micme requires a recording file name.");
	return name;
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
