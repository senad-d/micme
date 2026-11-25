import assert from "node:assert/strict";
import fs, { closeSync, constants, mkdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

const { createLiveRecordingDirectory, createProjectRecordingDirectory, createRecordingDirectory, formatRecordingDirectoryName } = await import("../src/recording-dir.ts");
const { openVerifiedWindowsFile, WindowsRecordingDirectory } = await import("../src/windows-recording-dir.ts");
const { PosixDirectory } = await import("../src/posix-directory.ts");
const { runProcess } = await import("../src/processes.ts");

async function createKeptPath(cwd) {
	const directory = await createProjectRecordingDirectory(cwd);
	directory.close();
	return directory.path;
}

test("kept audio uses the next sequential project recording directory", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const first = await createKeptPath(cwd);
	assert.equal(first, join(cwd, "micme-rec", "rec-001"));

	await mkdir(join(cwd, "micme-rec", "rec-003"));
	const fourth = await createKeptPath(cwd);
	assert.equal(fourth, join(cwd, "micme-rec", "rec-004"));
});

test("kept audio starts at rec-001 with a rec-1000000 file in the recordings root", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = join(cwd, "micme-rec");
	await mkdir(root);
	await writeFile(join(root, "rec-1000000"), "");

	assert.equal(await createKeptPath(cwd), join(root, "rec-001"));
});

test("kept audio ignores directories above the sequence limit", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = join(cwd, "micme-rec");
	await mkdir(root);
	await mkdir(join(root, "rec-999998"));
	await mkdir(join(root, "rec-1000000"));

	assert.equal(await createKeptPath(cwd), join(root, "rec-999999"));
});

test("kept audio ignores in-range files when numbering but skips a file at the candidate path", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = join(cwd, "micme-rec");
	await mkdir(root);
	await writeFile(join(root, "rec-001"), "");
	await writeFile(join(root, "rec-010"), "");

	assert.equal(await createKeptPath(cwd), join(root, "rec-002"));
});

test("kept audio creates a private root and leaf under umask 022", { skip: process.platform === "win32" }, async (t) => {
	const previousUmask = process.umask(0o022);
	t.after(() => process.umask(previousUmask));
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const leaf = await createKeptPath(cwd);

	assert.equal((await stat(dirname(leaf))).mode & 0o777, 0o700);
	assert.equal((await stat(leaf)).mode & 0o777, 0o700);
});

test("kept audio creates a private leaf without changing an existing 0755 root under umask 022", { skip: process.platform === "win32" }, async (t) => {
	const previousUmask = process.umask(0o022);
	t.after(() => process.umask(previousUmask));
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = join(cwd, "micme-rec");
	await mkdir(root, { mode: 0o755 });

	const leaf = await createKeptPath(cwd);

	assert.equal((await stat(root)).mode & 0o777, 0o755);
	assert.equal((await stat(leaf)).mode & 0o777, 0o700);
});

test("kept audio refuses a symlinked project recordings directory", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	const outside = await mkdtemp(join(tmpdir(), "micme-rec-outside-"));
	const linkPath = join(cwd, "micme-rec");
	t.after(() => rm(cwd, { recursive: true, force: true }));
	t.after(() => rm(outside, { recursive: true, force: true }));

	try {
		await symlink(outside, linkPath, "dir");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && ["EACCES", "EPERM"].includes(error.code)) {
			t.skip("directory symlinks are not permitted on this platform");
			return;
		}
		throw error;
	}

	await assert.rejects(() => createProjectRecordingDirectory(cwd), /symbolic-link recordings directory/);
});

async function makeSubstitutionFixture(t) {
	const base = await mkdtemp(join(tmpdir(), "micme-rec-substitution-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const project = join(base, "project");
	const root = join(project, "micme-rec");
	const moved = join(project, "original-root");
	const outside = join(base, "outside");
	const sentinel = join(outside, "rec-001", "raw.wav");
	await mkdir(root, { recursive: true });
	await mkdir(dirname(sentinel), { recursive: true });
	await writeFile(sentinel, "outside sentinel");
	return { project, root, moved, outside, sentinel };
}

async function substituteRoot({ root, moved, outside }) {
	await rename(root, moved);
	await symlink(outside, root, "dir");
}

const posixOnly = { skip: process.platform === "win32" && "Windows locks directories instead of allowing the fixture's rename" };

test("kept audio allocates beneath the opened root even if its public name is replaced", posixOnly, async (t) => {
	const fixture = await makeSubstitutionFixture(t);
	const list = PosixDirectory.prototype.listDirectories;
	t.mock.method(PosixDirectory.prototype, "listDirectories", async function () {
		// Replace the root once it has been opened but before listing or mkdir.
		await substituteRoot(fixture);
		return list.call(this);
	});

	const directory = await createProjectRecordingDirectory(fixture.project);
	try {
		assert.deepEqual(await readdir(fixture.moved), ["rec-001"]);
		assert.deepEqual(await readdir(fixture.outside), ["rec-001"]);
		assert.equal(await readFile(fixture.sentinel, "utf8"), "outside sentinel");
	} finally {
		directory.close();
	}
});

async function writeThroughRecordingTool(directory) {
	const path = join(directory.filesPath, "raw.wav");
	const result = await runProcess(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'owned recording')", path], 5_000, { cwdFd: directory.cwdFd });
	assert.equal(result.code, 0, result.stderr);
	const fd = directory.openFile(path, constants.O_RDONLY);
	try {
		assert.equal(readFileSync(fd, "utf8"), "owned recording");
	} finally {
		closeSync(fd);
	}
}

async function assertFilesStayBound(t) {
	const fixture = await makeSubstitutionFixture(t);
	const directory = await createProjectRecordingDirectory(fixture.project);
	try {
		await substituteRoot(fixture);
		await writeThroughRecordingTool(directory);
		assert.equal(await readFile(join(fixture.moved, "rec-001", "raw.wav"), "utf8"), "owned recording");
		assert.equal(await readFile(fixture.sentinel, "utf8"), "outside sentinel");
		await directory.remove();
		assert.equal(await readFile(fixture.sentinel, "utf8"), "outside sentinel");
		assert.deepEqual(await readdir(fixture.moved), []);
	} finally {
		directory.close();
	}
}

test("recording file access and cleanup use the original directory after root substitution", posixOnly, assertFilesStayBound);

function disableProcAccess(t) {
	const statPath = fs.statSync;
	const statMock = t.mock.method(fs, "statSync", (path, options) => typeof path === "string" && path.startsWith(`/proc/${process.pid}/fd/`) ? undefined : statPath(path, options));
	syncBuiltinESMExports();
	t.after(() => {
		statMock.mock.restore();
		syncBuiltinESMExports();
	});
}

test("the descriptor-relative subprocess fallback stays bound without /proc", { skip: process.platform !== "linux" }, async (t) => {
	disableProcAccess(t);
	await assertFilesStayBound(t);
});

test("private snapshot creation is exclusive and owner-only in the descriptor-relative fallback", { skip: process.platform === "win32" }, async (t) => {
	if (process.platform === "linux") disableProcAccess(t);
	const directory = await createLiveRecordingDirectory(".", false, "micme-live-dir-test-");
	t.after(async () => {
		try {
			await directory.remove();
		} finally {
			directory.close();
		}
	});
	assert.notEqual(directory.cwdFd, undefined);
	const original = process.umask(0o022);
	try {
		closeSync(directory.createPrivateFile("snapshot.wav"));
	} finally {
		process.umask(original);
	}
	assert.equal((await stat(join(directory.path, "snapshot.wav"))).mode & 0o777, 0o600);
	assert.throws(() => directory.createPrivateFile("snapshot.wav"), { code: "EEXIST" });
});

test("cleanup refuses a same-named replacement leaf even in the original root", posixOnly, async (t) => {
	const fixture = await makeSubstitutionFixture(t);
	const directory = await createProjectRecordingDirectory(fixture.project);
	const movedLeaf = join(fixture.root, "original-leaf");
	try {
		await writeThroughRecordingTool(directory);
		await rename(directory.path, movedLeaf);
		await rename(dirname(fixture.sentinel), directory.path);
		await assert.rejects(directory.remove(), /identity changed/);
		assert.equal(await readFile(join(directory.path, "raw.wav"), "utf8"), "outside sentinel");
		assert.equal(await readFile(join(movedLeaf, "raw.wav"), "utf8"), "owned recording");
	} finally {
		directory.close();
	}
});

test("non-kept audio still uses the system temp directory", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	const directory = await createRecordingDirectory(cwd, false, "micme-test-");

	t.after(() => rm(cwd, { recursive: true, force: true }));
	t.after(() => directory.remove());

	assert.equal(dirname(directory.path), tmpdir());
	assert.ok(basename(directory.path).startsWith("micme-test-"));
});

test("verified live temp access inspects the held directory, rejecting a substituted path and nonregular leaves", posixOnly, async (t) => {
	const directory = await createLiveRecordingDirectory(".", false, "micme-live-dir-test-");
	const moved = `${directory.path}-original`;
	t.after(async () => {
		directory.close();
		await rm(moved, { recursive: true, force: true });
		await rm(directory.path, { recursive: true, force: true });
	});
	assert.equal(directory.openVerifiedFile(join(directory.path, "missing.wav")), undefined);
	await writeFile(join(directory.path, "raw.wav"), "original");
	await symlink("raw.wav", join(directory.path, "symlink.wav"));
	await mkdir(join(directory.path, "directory.wav"));
	await rename(directory.path, moved);
	await mkdir(directory.path);
	await writeFile(join(directory.path, "raw.wav"), "replaced");
	assert.throws(() => directory.openVerifiedFile(join(directory.path, "symlink.wav")), { code: "ELOOP" });
	assert.throws(() => directory.openVerifiedFile(join(directory.path, "directory.wav")), /regular file/);
	const file = directory.openVerifiedFile(join(directory.path, "raw.wav"));
	try {
		assert.equal(directory.verifiedDisplayPath(), undefined);
		assert.equal(await directory.containsVerifiedFile(file), true);
		assert.equal(file.size(), 8);
		const bytes = Buffer.alloc(4);
		assert.equal(await file.readAt(bytes, 4), 4);
		assert.equal(bytes.toString(), "inal");
	} finally {
		file.close();
	}
});

for (const access of ["normal", "descriptor fallback without /proc"]) {
	test(`verified file retention distinguishes a moved original from a same-size replacement (${access})`, {
		skip: process.platform === "win32" || (access !== "normal" && process.platform !== "linux"),
	}, async (t) => {
		if (access !== "normal") disableProcAccess(t);
		const directory = await createLiveRecordingDirectory(".", false, "micme-live-dir-test-");
		const path = join(directory.path, "raw.wav");
		const moved = join(directory.path, "renamed.wav");
		try {
			await writeFile(path, "verified");
			const file = directory.openVerifiedFile(path);
			try {
				assert.equal(directory.verifiedDisplayPath(), directory.path);
				await rename(path, moved);
				await writeFile(path, "replaced");
				assert.equal(await directory.containsVerifiedFile(file), true);
				await rm(moved);
				assert.equal(await directory.containsVerifiedFile(file), false);
			} finally {
				file.close();
			}
		} finally {
			try {
				await directory.remove();
			} finally {
				directory.close();
			}
		}
	});
}

async function withRetentionTree(t, access, check) {
	if (access !== "normal") disableProcAccess(t);
	const root = await mkdtemp(join(tmpdir(), "micme-retention-tree-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = await createLiveRecordingDirectory(root, true);
	const path = join(directory.path, "raw.wav");
	await writeFile(path, "verified");
	const file = directory.openVerifiedFile(path);
	try {
		await check({ root, directory, path, file });
	} finally {
		file.close();
		directory.close();
	}
}

for (const access of ["normal", "descriptor fallback without /proc"]) {
	const options = { skip: process.platform === "win32" || (access !== "normal" && process.platform !== "linux") };
	test(`verified retention finds the original in a nested archive (${access})`, options, async (t) => {
		await withRetentionTree(t, access, async ({ directory, path, file }) => {
			// POSIX names are bytes. Reconstructing this parent as UTF-8 can miss the capture.
			const archive = Buffer.concat([Buffer.from(`${directory.path}/archive-`), Buffer.from([0xff])]);
			const child = Buffer.concat([archive, Buffer.from("/session")]);
			const archived = Buffer.concat([child, Buffer.from("/original.wav")]);
			await mkdir(archive);
			await mkdir(child);
			await rename(path, archived);
			await writeFile(path, "replaced");
			assert.equal(await directory.containsVerifiedFile(file), true);
			assert.equal(await readFile(archived, "utf8"), "verified");
		});
	});

	test(`verified retention never reaches the original through a link outside the spool (${access})`, options, async (t) => {
		await withRetentionTree(t, access, async ({ root, directory, path, file }) => {
			const outside = join(root, "outside");
			const original = join(outside, "original.wav");
			const archive = join(directory.path, "archive");
			await mkdir(outside);
			await mkdir(archive);
			await rename(path, original);
			await writeFile(join(archive, "original.wav"), "replaced");
			await symlink(outside, join(archive, "directory-link"));
			await symlink(original, join(archive, "file-link.wav"));
			await symlink(directory.path, join(archive, "cycle"));
			assert.equal(await directory.containsVerifiedFile(file), false);
			file.close();
			await directory.remove();
			assert.equal(await readFile(original, "utf8"), "verified");
		});
	});

	test(`verified retention rejects a substituted directory before trusting a nested match (${access})`, options, async (t) => {
		await withRetentionTree(t, access, async ({ root, directory, path, file }) => {
			const archive = join(directory.path, "archive");
			const moved = join(root, "moved");
			await mkdir(archive);
			await rename(path, join(archive, "original.wav"));
			const open = PosixDirectory.prototype.openDirectory;
			const swap = t.mock.method(PosixDirectory.prototype, "openDirectory", function (name) {
				const child = open.call(this, name);
				if (this.procPath === directory.filesPath || (directory.cwdFd !== undefined && this.fd === directory.cwdFd)) {
					renameSync(archive, moved);
					mkdirSync(archive);
					swap.mock.restore();
				}
				return child;
			});
			await assert.rejects(directory.containsVerifiedFile(file), /identity.*changed/);
			assert.equal(await readFile(join(moved, "original.wav"), "utf8"), "verified");
		});
	});

	test(`verified retention does not follow a directory replaced by a symlink during the scan (${access})`, options, async (t) => {
		await withRetentionTree(t, access, async ({ root, directory, path, file }) => {
			const archive = join(directory.path, "archive");
			const moved = join(root, "moved");
			await mkdir(archive);
			await rename(path, join(archive, "original.wav"));
			const open = PosixDirectory.prototype.openDirectory;
			const swap = t.mock.method(PosixDirectory.prototype, "openDirectory", function (name) {
				if (this.procPath === directory.filesPath || (directory.cwdFd !== undefined && this.fd === directory.cwdFd)) {
					renameSync(archive, moved);
					symlinkSync(moved, archive);
					swap.mock.restore();
				}
				return open.call(this, name);
			});
			await assert.rejects(directory.containsVerifiedFile(file), (error) => ["ELOOP", "ENOTDIR"].includes(error.code));
			assert.equal(await readFile(join(moved, "original.wav"), "utf8"), "verified");
		});
	});
}

function fakeWindowsFile({ type = 1, attributes = 0, verified = true } = {}) {
	const events = [];
	const handle = 1234n;
	const fixture = {
		events,
		api: {
			open: (path, rights, share, security, disposition, flags) => {
				assert.match(path, /raw\.wav$/);
				assert.equal(rights, 0x80000000);
				assert.equal(share & 3, 3); // allow existing recorder read/write access
				assert.equal(disposition, 3); // open existing, no creation
				assert.equal(flags & 0x00200000, 0x00200000); // don't follow reparse points
				return handle;
			},
			lastError: () => assert.fail("successful open does not require GetLastError"),
			fileType: (file) => { assert.equal(file, handle); return type; },
			information: (file, infoClass, buffer) => {
				assert.equal(file, handle);
				assert.equal(infoClass, 9);
				buffer.writeUInt32LE(attributes);
				return verified;
			},
			fileSize: (file, buffer) => {
				assert.equal(file, handle);
				buffer.writeBigInt64LE(8n);
				return 1;
			},
			seek: (file, offset) => { assert.equal(file, handle); events.push(offset); return 1; },
			read: async (file, buffer, count) => {
				assert.equal(file, handle);
				assert.equal(count, 4);
				buffer.write("held");
				events.push("read");
				return count;
			},
			close: (file) => { assert.equal(file, handle); events.push("close"); },
		},
	};
	return fixture;
}

const WINDOWS_LEAF = String.raw`C:\Micme\raw.wav`;

test("the Windows verified-open boundary rejects unsafe or unverifiable handles before reading", () => {
	for (const options of [{ type: 3 }, { attributes: 0x400 }, { attributes: 0x10 }, { verified: false }]) {
		const { api, events } = fakeWindowsFile(options);
		assert.throws(() => openVerifiedWindowsFile(WINDOWS_LEAF, api), /verify|regular disk file/);
		assert.deepEqual(events, ["close"]);
	}
});

test("Windows size and positional reads use only the verified handle, which closes once", async () => {
	const { api, events } = fakeWindowsFile();
	const file = openVerifiedWindowsFile(WINDOWS_LEAF, api);
	assert.equal(file.size(), 8);
	const bytes = Buffer.alloc(4);
	assert.equal(await file.readAt(bytes, 4), 4);
	assert.equal(bytes.toString(), "held");
	file.close();
	file.close();
	assert.deepEqual(events, [4, "read", "close"]);
});

function windowsTreeFixture({ junction = false, traversal = false } = {}) {
	const root = String.raw`C:\Micme`;
	const entries = new Map([
		[root, { id: 1, attributes: 0x10, names: ["raw.wav", traversal ? ".." : "archive"] }],
		[`${root}\\raw.wav`, { id: 2, attributes: 0 }],
		[`${root}\\archive`, { id: 3, attributes: junction ? 0x410 : 0x10, names: ["original.wav"] }],
		[`${root}\\archive\\original.wav`, { id: 4, attributes: 0 }],
	]);
	const opened = new Map();
	const read = [];
	const native = {
		open: (absolutePath, access, share, security, disposition, flags) => {
			assert.ok(flags & 0x00200000, "must open the entry, not its reparse target");
			const path = absolutePath.slice(4); // Drop the Windows namespaced path prefix.
			const entry = entries.get(path);
			assert.ok(entry, `unexpected open outside the Windows tree: ${path}`);
			if (entry.names) assert.equal(share, 1, "directories must not share write/delete access");
			const handle = BigInt(entry.id);
			opened.set(handle, entry);
			return handle;
		},
		information: (handle, kind, buffer) => {
			const entry = opened.get(handle);
			assert.ok(entry, "information read without a held handle");
			if (kind === 9) buffer.writeUInt32LE(entry.attributes);
			else {
				assert.equal(kind, 18);
				buffer.writeBigUInt64LE(9n, 0); // volume serial number
				buffer.writeBigUInt64LE(BigInt(entry.id), 16);
			}
			return 1;
		},
		close: (handle) => assert.equal(opened.delete(handle), true),
		fileType: () => 1,
	};
	const list = async (path) => {
		const entry = entries.get(path);
		assert.ok(entry && opened.has(BigInt(entry.id)), "enumeration requires a verified, locked directory");
		assert.equal(entry.attributes & 0x400, 0, "never enumerate behind a reparse entry");
		read.push(path);
		return entry.names.map((name) => ({ name, isDirectory: () => !name.endsWith(".wav"), isFile: () => name.endsWith(".wav") }));
	};
	const expected = Buffer.alloc(24);
	expected.writeBigUInt64LE(9n, 0);
	expected.writeBigUInt64LE(4n, 16);
	return { root, opened, read, native, list, identity: expected.toString("hex") };
}

test("Windows verified retention locks nested directories and compares file IDs, not names", async () => {
	const { root, opened, read, native, list, identity } = windowsTreeFixture();
	const directory = new WindowsRecordingDirectory(root, undefined, native, list);
	try {
		assert.equal(await directory.containsFile(identity), true);
		assert.equal(await directory.containsFile("same names but a different identity"), false);
		assert.deepEqual(read, [root, `${root}\\archive`, root, `${root}\\archive`]);
		assert.deepEqual([...opened.keys()], [1n]);
	} finally {
		directory.close();
	}
	assert.equal(opened.size, 0);
});

for (const hazard of ["junction", "traversal"]) {
	test(`Windows verified retention does not enumerate through a ${hazard} entry`, async () => {
		const { root, opened, read, native, list, identity } = windowsTreeFixture({ [hazard]: true });
		const directory = new WindowsRecordingDirectory(root, undefined, native, list);
		try {
			await assert.rejects(directory.containsFile(identity), hazard === "junction" ? /reparse point/ : /invalid.*entry/i);
			assert.deepEqual(read, [root]);
			assert.deepEqual([...opened.keys()], [1n]);
		} finally {
			directory.close();
		}
	});
}

test("recording directory names keep at least three digits", () => {
	assert.equal(formatRecordingDirectoryName(1), "rec-001");
	assert.equal(formatRecordingDirectoryName(42), "rec-042");
	assert.equal(formatRecordingDirectoryName(1000), "rec-1000");
});
