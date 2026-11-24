import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

const { createProjectRecordingDirectory, createRecordingDirectory, formatRecordingDirectoryName } = await import("../src/recording-dir.ts");

test("kept audio uses the next sequential project recording directory", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const first = await createProjectRecordingDirectory(cwd);
	assert.equal(first, join(cwd, "micme-rec", "rec-001"));

	await mkdir(join(cwd, "micme-rec", "rec-003"));
	const fourth = await createProjectRecordingDirectory(cwd);
	assert.equal(fourth, join(cwd, "micme-rec", "rec-004"));
});

test("kept audio starts at rec-001 with a rec-1000000 file in the recordings root", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = join(cwd, "micme-rec");
	await mkdir(root);
	await writeFile(join(root, "rec-1000000"), "");

	assert.equal(await createProjectRecordingDirectory(cwd), join(root, "rec-001"));
});

test("kept audio ignores directories above the sequence limit", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = join(cwd, "micme-rec");
	await mkdir(root);
	await mkdir(join(root, "rec-999998"));
	await mkdir(join(root, "rec-1000000"));

	assert.equal(await createProjectRecordingDirectory(cwd), join(root, "rec-999999"));
});

test("kept audio ignores in-range files when numbering but skips a file at the candidate path", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = join(cwd, "micme-rec");
	await mkdir(root);
	await writeFile(join(root, "rec-001"), "");
	await writeFile(join(root, "rec-010"), "");

	assert.equal(await createProjectRecordingDirectory(cwd), join(root, "rec-002"));
});

test("kept audio creates a private root and leaf under umask 022", { skip: process.platform === "win32" }, async (t) => {
	const previousUmask = process.umask(0o022);
	t.after(() => process.umask(previousUmask));
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const leaf = await createProjectRecordingDirectory(cwd);

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

	const leaf = await createProjectRecordingDirectory(cwd);

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

test("non-kept audio still uses the system temp directory", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "micme-rec-test-"));
	const dir = await createRecordingDirectory(cwd, false, "micme-test-");

	t.after(() => rm(cwd, { recursive: true, force: true }));
	t.after(() => rm(dir, { recursive: true, force: true }));

	assert.equal(dirname(dir), tmpdir());
	assert.ok(basename(dir).startsWith("micme-test-"));
});

test("recording directory names keep at least three digits", () => {
	assert.equal(formatRecordingDirectoryName(1), "rec-001");
	assert.equal(formatRecordingDirectoryName(42), "rec-042");
	assert.equal(formatRecordingDirectoryName(1000), "rec-1000");
});
