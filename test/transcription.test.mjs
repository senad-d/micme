import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_CAPTURED_OUTPUT_CHARS } from "../src/constants.ts";
import { shellQuote } from "../src/processes.ts";
import { transcribeWithCustomCommand } from "../src/transcription.ts";

async function makeTranscriptDirectory(t) {
	const tempDir = await mkdtemp(join(tmpdir(), "micme-transcript-"));
	t.after(() => rm(tempDir, { recursive: true, force: true }));
	return tempDir;
}

function transcribeStdout(tempDir, length) {
	// The unused placeholder selects verbatim shell quoting on Windows.
	const command = `${shellQuote(process.execPath)} -e "process.stdout.write('a' + 'x'.repeat(${length - 1}))" {audio}`;
	return transcribeWithCustomCommand(command, join(tempDir, "raw.wav"), tempDir);
}

test("a stdout transcript at the capture limit is returned in full", async (t) => {
	const tempDir = await makeTranscriptDirectory(t);
	const transcript = await transcribeStdout(tempDir, MAX_CAPTURED_OUTPUT_CHARS);
	assert.equal(transcript, "a" + "x".repeat(MAX_CAPTURED_OUTPUT_CHARS - 1));
});

test("a truncated stdout fallback rejects instead of returning transcript text", async (t) => {
	const tempDir = await makeTranscriptDirectory(t);
	await assert.rejects(transcribeStdout(tempDir, MAX_CAPTURED_OUTPUT_CHARS + 1), /stdout.*capture limit.*truncated/i);
});

test("an intact transcript file takes precedence over truncated stdout", async (t) => {
	const tempDir = await makeTranscriptDirectory(t);
	await writeFile(join(tempDir, "transcript.txt"), "A complete transcript.\n");
	assert.equal(await transcribeStdout(tempDir, MAX_CAPTURED_OUTPUT_CHARS + 1), "A complete transcript.\n");
});
