import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
