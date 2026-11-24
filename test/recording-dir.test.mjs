import assert from "node:assert/strict";
import fs, { closeSync, constants, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

const { createProjectRecordingDirectory, createRecordingDirectory, formatRecordingDirectoryName } = await import("../src/recording-dir.ts");
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

test("the descriptor-relative subprocess fallback stays bound without /proc", { skip: process.platform !== "linux" }, async (t) => {
	const statPath = fs.statSync;
	const statMock = t.mock.method(fs, "statSync", (path, options) => typeof path === "string" && path.startsWith(`/proc/${process.pid}/fd/`) ? undefined : statPath(path, options));
	syncBuiltinESMExports();
	t.after(() => {
		statMock.mock.restore();
		syncBuiltinESMExports();
	});
	await assertFilesStayBound(t);
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

test("recording directory names keep at least three digits", () => {
	assert.equal(formatRecordingDirectoryName(1), "rec-001");
	assert.equal(formatRecordingDirectoryName(42), "rec-042");
	assert.equal(formatRecordingDirectoryName(1000), "rec-1000");
});
