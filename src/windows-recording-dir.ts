import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import type { VerifiedRecordingFile } from "./recording-dir.ts";

const requireNative = createRequire(import.meta.url);
const FILE_LIST_DIRECTORY = 1;
const FILE_READ_ATTRIBUTES = 0x80;
const DELETE = 0x10000;
const FILE_SHARE_READ = 1;
const FILE_SHARE_ALL = 7;
const OPEN_EXISTING = 3;
const OPEN_DIRECTORY_NO_REPARSE = 0x02200000; // BACKUP_SEMANTICS | OPEN_REPARSE_POINT; also permits inspecting a directory leaf
const GENERIC_READ = 0x80000000;
const FILE_TYPE_DISK = 1;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const ERROR_FILE_NOT_FOUND = 2;
const DIRECTORY = 0x10;
const REPARSE_POINT = 0x400;
let api: ReturnType<typeof loadWindowsApi> | undefined;

function loadWindowsApi() {
	const koffi: typeof import("koffi") = requireNative("koffi");
	const kernel32 = koffi.load("kernel32.dll");
	const read = kernel32.func("int __stdcall ReadFile(void *, void *, uint32_t, void *, void *)");
	return {
		open: kernel32.func("void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)"),
		reopen: kernel32.func("void * __stdcall ReOpenFile(void *, uint32_t, uint32_t, uint32_t)"),
		information: kernel32.func("int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)"),
		setInformation: kernel32.func("int __stdcall SetFileInformationByHandle(void *, int, void *, uint32_t)"),
		close: kernel32.func("int __stdcall CloseHandle(void *)"),
		lastError: kernel32.func("uint32_t __stdcall GetLastError()"),
		fileType: kernel32.func("uint32_t __stdcall GetFileType(void *)"),
		fileSize: kernel32.func("int __stdcall GetFileSizeEx(void *, void *)"),
		seek: kernel32.func("int __stdcall SetFilePointerEx(void *, int64_t, void *, uint32_t)"),
		read: (handle: bigint, bytes: Buffer, count: number) => readWindowsFile(read, handle, bytes, count),
	};
}

function validHandle(handle: bigint | null): handle is bigint {
	return Boolean(handle && handle !== -1n && handle !== 0xffffffffffffffffn && handle !== 0xffffffffn);
}

type WindowsFileApi = Pick<ReturnType<typeof loadWindowsApi>, "open" | "lastError" | "fileType" | "information" | "fileSize" | "seek" | "read" | "close">;

function readWindowsEntries(path: string) {
	return readdir(path, { withFileTypes: true });
}

function windowsFileId(native: Pick<WindowsFileApi, "information">, handle: bigint) {
	const id = Buffer.alloc(24); // FILE_ID_INFO: volume serial number and 128-bit file ID
	if (native.information(handle, 18, id, id.length)) return id.toString("hex"); // FileIdInfo
	throw new Error("Micme could not read a Windows recording file or directory identity.");
}

function readWindowsFile(read: ReturnType<ReturnType<typeof import("koffi").load>["func"]>, handle: bigint, bytes: Buffer, count: number) {
	return new Promise<number>((resolve, reject) => {
		const transferred = Buffer.alloc(4);
		read.async(handle, bytes, count, transferred, null, (error: unknown, success: number) => {
			if (error) reject(error);
			else if (!success) reject(new Error("Windows could not read Micme's live recording file."));
			else resolve(transferred.readUInt32LE());
		});
	});
}

export function openVerifiedWindowsFile(path: string, native: WindowsFileApi): VerifiedRecordingFile | undefined {
	const handle: bigint | null = native.open(win32.toNamespacedPath(path), GENERIC_READ, FILE_SHARE_ALL, null, OPEN_EXISTING, OPEN_DIRECTORY_NO_REPARSE, null);
	if (!validHandle(handle)) {
		// Poll only for a missing leaf; unverifiable or inaccessible files fail closed.
		if (native.lastError() === ERROR_FILE_NOT_FOUND) return undefined;
		throw new Error("Windows could not open Micme's live recording file for verification.");
	}
	try {
		if (native.fileType(handle) !== FILE_TYPE_DISK) throw new Error("Micme's live recording leaf is not a regular disk file.");
		const info = Buffer.alloc(8);
		if (!native.information(handle, FILE_ATTRIBUTE_TAG_INFO, info, info.length)) throw new Error("Windows could not verify Micme's live recording file attributes.");
		if (info.readUInt32LE(0) & (DIRECTORY | REPARSE_POINT)) throw new Error("Micme's live recording leaf is not a regular disk file.");
		return new WindowsRecordingFile(native, handle);
	} catch (error) {
		native.close(handle);
		throw error;
	}
}

class WindowsRecordingFile implements VerifiedRecordingFile {
	private readonly native: WindowsFileApi;
	private handle?: bigint;

	constructor(native: WindowsFileApi, handle: bigint) {
		this.native = native;
		this.handle = handle;
	}

	private openedHandle() {
		if (this.handle === undefined) throw new Error("Micme's live recording file is closed.");
		return this.handle;
	}

	identity() {
		return windowsFileId(this.native, this.openedHandle());
	}

	snapshotStamp() {
		const handle = this.openedHandle();
		const basic = Buffer.alloc(40); // FILE_BASIC_INFO
		const standard = Buffer.alloc(24); // FILE_STANDARD_INFO
		if (!this.native.information(handle, 0, basic, basic.length) || !this.native.information(handle, 1, standard, standard.length)) {
			throw new Error("Windows could not verify the stopped recording's file metadata.");
		}
		if (standard.readUInt32LE(16) !== 1 || standard[20]) throw new Error("Micme cannot verify an unbound or hard-linked recording leaf.");
		// File size, last-write and metadata-change times (not access time).
		return `${standard.readBigInt64LE(8)}:${basic.readBigInt64LE(16)}:${basic.readBigInt64LE(24)}`;
	}

	size() {
		const size = Buffer.alloc(8);
		if (!this.native.fileSize(this.openedHandle(), size)) throw new Error("Windows could not read the live recording size.");
		return Number(size.readBigInt64LE());
	}

	readAt(bytes: Buffer, offset: number) {
		const handle = this.openedHandle();
		// The LivePcmReader serializes reads: only this reader moves the pointer
		// of this handle, and the recorder opened its own handle.
		if (!this.native.seek(handle, offset, null, 0)) throw new Error("Windows could not seek in the live recording file.");
		return this.native.read(handle, bytes, bytes.length);
	}

	close() {
		if (this.handle === undefined) return;
		const handle = this.handle;
		this.handle = undefined;
		this.native.close(handle);
	}
}

export class WindowsRecordingDirectory {
	private readonly api: ReturnType<typeof loadWindowsApi>;
	private readonly readEntries: typeof readWindowsEntries;
	private handle: bigint | undefined;
	readonly path: string;
	private readonly parent?: WindowsRecordingDirectory;

	constructor(path: string, parent?: WindowsRecordingDirectory, native = parent?.api ?? (api ??= loadWindowsApi()), readEntries = parent?.readEntries ?? readWindowsEntries) {
		this.api = native;
		this.readEntries = readEntries;
		this.path = path;
		this.parent = parent;
		// No sharing for delete or write: a different handle cannot rename this
		// directory or turn it into a junction while hooks use its path.
		const handle = this.open(FILE_READ_ATTRIBUTES);
		this.handle = handle;
		try {
			const info = Buffer.alloc(8); // attributes and reparse tag
			if (!this.api.information(handle, FILE_ATTRIBUTE_TAG_INFO, info, info.length)) throw new Error(`Micme could not verify its recording directory: ${path}.`);
			const attributes = info.readUInt32LE(0);
			if (!(attributes & DIRECTORY) || (attributes & REPARSE_POINT)) throw new Error(`Micme refuses to use a symbolic-link recordings directory or other reparse point: ${path}.`);
		} catch (error) {
			this.closeOnly();
			throw error;
		}
	}

	static async openProject(project: string) {
		// Resolve the workspace selected by Pi once, then lock each physical
		// ancestor from the volume down before trusting the next path component.
		const physical = await realpath(project);
		const { root } = win32.parse(physical);
		let current = new WindowsRecordingDirectory(root);
		try {
			for (const name of physical.slice(root.length).split("\\").filter(Boolean)) current = current.openDirectory(name);
			return current;
		} catch (error) {
			current.close();
			throw error;
		}
	}

	openVerifiedFile(name: string) {
		if (this.handle === undefined) throw new Error("Micme's Windows recording directory lock is closed.");
		return openVerifiedWindowsFile(win32.join(this.path, name), this.api);
	}

	async containsFile(identity: string): Promise<boolean> {
		if (this.handle === undefined) throw new Error("Micme's Windows recording directory lock is closed.");
		const entries = await this.readEntries(this.path);
		for (const entry of entries) {
			if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/:\0]/.test(entry.name)) {
				throw new Error("Micme refused to inspect an invalid recording directory entry.");
			}
			if (entry.isDirectory()) {
				// Verify and lock every directory in the chain before enumerating its
				// path. The native open rejects junctions, mounts and reparse points.
				const child = this.openDirectory(entry.name);
				try {
					if (await child.containsFile(identity)) return true;
				} finally {
					child.closeOnly();
				}
			} else if (entry.isFile()) {
				const file = this.openVerifiedFile(entry.name);
				if (!file) continue;
				try {
					if (file.identity() === identity) return true;
				} finally {
					file.close();
				}
			}
		}
		return false;
	}

	openDirectory(name: string) {
		return new WindowsRecordingDirectory(win32.join(this.path, name), this);
	}

	mkdir(name: string, mode: number) {
		return mkdir(win32.join(this.path, name), { mode });
	}

	async listDirectories() {
		const entries = await this.readEntries(this.path);
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	}

	async remove() {
		// Bound recursive removals to one subtree at a time and stop on the first failure.
		for (const name of await readdir(this.path)) {
			await rm(win32.join(this.path, name), { recursive: true, force: true });
		}
		this.removeEmptyDirectory();
	}

	private removeEmptyDirectory() {
		// Keep the original file ID alive while changing from the run-time lock
		// (which forbids delete access) to a handle capable of deleting the leaf.
		const reference: bigint | null = this.api.reopen(this.handle, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, OPEN_DIRECTORY_NO_REPARSE);
		if (!validHandle(reference)) throw new Error(`Micme could not retain the recording directory identity: ${this.path}.`);
		try {
			const expectedId = windowsFileId(this.api, reference);
			this.closeOnly();
			const removal = this.open(FILE_READ_ATTRIBUTES | DELETE);
			try {
				if (windowsFileId(this.api, removal) !== expectedId) throw new Error(`Micme refused to remove a recording directory whose identity changed: ${this.path}.`);
				if (!this.api.setInformation(removal, 4, Buffer.from([1]), 1)) { // FileDispositionInfo
					throw new Error(`Windows refused to remove the owned Micme recording directory: ${this.path}.`);
				}
			} finally {
				this.api.close(removal);
			}
		} finally {
			this.api.close(reference);
		}
	}

	private open(access: number) {
		// A metadata-only handle does not participate in Windows sharing checks.
		const handle: bigint | null = this.api.open(win32.toNamespacedPath(this.path), access | FILE_LIST_DIRECTORY,
			FILE_SHARE_READ, null, OPEN_EXISTING, OPEN_DIRECTORY_NO_REPARSE, null);
		if (validHandle(handle)) return handle;
		throw new Error(`Micme could not lock its recording directory: ${this.path}.`);
	}

	close() {
		this.closeOnly();
		this.parent?.close();
	}

	private closeOnly() {
		if (this.handle === undefined) return;
		this.api.close(this.handle);
		this.handle = undefined;
	}
}
