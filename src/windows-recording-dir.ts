import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { win32 } from "node:path";

const requireNative = createRequire(import.meta.url);
const FILE_LIST_DIRECTORY = 1;
const FILE_READ_ATTRIBUTES = 0x80;
const DELETE = 0x10000;
const FILE_SHARE_READ = 1;
const FILE_SHARE_ALL = 7;
const OPEN_EXISTING = 3;
const OPEN_DIRECTORY_NO_REPARSE = 0x02200000; // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
const DIRECTORY = 0x10;
const REPARSE_POINT = 0x400;
let api: ReturnType<typeof loadWindowsApi> | undefined;

function loadWindowsApi() {
	const koffi: typeof import("koffi") = requireNative("koffi");
	const kernel32 = koffi.load("kernel32.dll");
	return {
		open: kernel32.func("void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)"),
		reopen: kernel32.func("void * __stdcall ReOpenFile(void *, uint32_t, uint32_t, uint32_t)"),
		information: kernel32.func("int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)"),
		setInformation: kernel32.func("int __stdcall SetFileInformationByHandle(void *, int, void *, uint32_t)"),
		close: kernel32.func("int __stdcall CloseHandle(void *)"),
	};
}

function validHandle(handle: bigint | null): handle is bigint {
	return Boolean(handle && handle !== -1n && handle !== 0xffffffffffffffffn && handle !== 0xffffffffn);
}

export class WindowsRecordingDirectory {
	private readonly api: ReturnType<typeof loadWindowsApi>;
	private handle: bigint | undefined;
	readonly path: string;
	private readonly parent?: WindowsRecordingDirectory;

	constructor(path: string, parent?: WindowsRecordingDirectory) {
		api ??= loadWindowsApi();
		this.api = api;
		this.path = path;
		this.parent = parent;
		// No sharing for delete or write: a different handle cannot rename this
		// directory or turn it into a junction while hooks use its path.
		const handle = this.open(FILE_READ_ATTRIBUTES);
		this.handle = handle;
		const info = Buffer.alloc(8); // FILE_ATTRIBUTE_TAG_INFO, including the reparse tag
		if (!this.api.information(handle, 9, info, info.length)) {
			this.closeOnly();
			throw new Error(`Micme could not verify its recording directory: ${path}.`);
		}
		const attributes = info.readUInt32LE(0);
		if ((attributes & DIRECTORY) && !(attributes & REPARSE_POINT)) return;
		this.closeOnly();
		throw new Error(`Micme refuses to use a symbolic-link recordings directory or other reparse point: ${path}.`);
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

	openDirectory(name: string) {
		return new WindowsRecordingDirectory(win32.join(this.path, name), this);
	}

	mkdir(name: string, mode: number) {
		return mkdir(win32.join(this.path, name), { mode });
	}

	async listDirectories() {
		const entries = await readdir(this.path, { withFileTypes: true });
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
			const expectedId = this.fileId(reference);
			this.closeOnly();
			const removal = this.open(FILE_READ_ATTRIBUTES | DELETE);
			try {
				if (!this.fileId(removal).equals(expectedId)) throw new Error(`Micme refused to remove a recording directory whose identity changed: ${this.path}.`);
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

	private fileId(handle: bigint) {
		const id = Buffer.alloc(24); // FILE_ID_INFO: volume serial number and 128-bit file ID
		if (this.api.information(handle, 18, id, id.length)) return id; // FileIdInfo
		throw new Error(`Micme could not read the recording directory identity: ${this.path}.`);
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
