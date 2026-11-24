import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { transcribeWithCustomCommand } from "../src/transcription.ts";

const execFileAsync = promisify(execFile);
const transcriptionModule = new URL("../src/transcription.ts", import.meta.url).href;
const checkWriterlessFifo = `
import assert from "node:assert/strict";
import { join } from "node:path";
const [moduleUrl, tempDir] = process.argv.slice(1);
const { transcribeWithCustomCommand } = await import(moduleUrl);
await assert.rejects(
	transcribeWithCustomCommand("mkfifo {transcript} && echo fallback", join(tempDir, "audio.wav"), tempDir),
	/Transcript output is not a regular file/,
);
`;

async function createTranscriptDir(t) {
	const dir = await mkdtemp(join(tmpdir(), "micme-transcription-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("a successful custom hook with a writerless FIFO rejects promptly", { skip: process.platform === "win32" && "requires a POSIX FIFO" }, async (t) => {
	const dir = await createTranscriptDir(t);
	// Run in a disposable process so a blocked FIFO open cannot hang the test runner.
	await execFileAsync(process.execPath, ["--input-type=module", "--eval", checkWriterlessFifo, transcriptionModule, dir], {
		timeout: 5_000,
		killSignal: "SIGKILL",
	});
});

test("a nonblank regular transcript overrides stdout without changing its contents", async (t) => {
	const dir = await createTranscriptDir(t);
	const contents = "  transcript text\nsecond line  \n";
	await writeFile(join(dir, "transcript.txt"), contents);

	const result = await transcribeWithCustomCommand("echo fallback", join(dir, "audio.wav"), dir);
	assert.equal(result, contents);
});

test("a blank regular transcript falls back to stdout", async (t) => {
	const dir = await createTranscriptDir(t);
	await writeFile(join(dir, "transcript.txt"), " \t\n");

	const result = await transcribeWithCustomCommand("echo fallback", join(dir, "audio.wav"), dir);
	assert.equal(result.trim(), "fallback");
});
