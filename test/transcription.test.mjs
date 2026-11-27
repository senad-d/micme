import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { MAX_CAPTURED_OUTPUT_CHARS } from "../src/constants.ts";
import { shellQuote } from "../src/processes.ts";
import { RecordingDirectory } from "../src/recording-dir.ts";
import { transcribeInstalledWhisper, transcribeWithCustomCommand } from "../src/transcription.ts";

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

function transcribeStdout(tempDir, length) {
	// The unused placeholder selects verbatim shell quoting on Windows.
	const command = `${shellQuote(process.execPath)} -e "process.stdout.write('a' + 'x'.repeat(${length - 1}))" {audio}`;
	return transcribeWithCustomCommand(command, join(tempDir, "raw.wav"), tempDir);
}

test("installed Whisper file inference reports observed compute and uses the fixed task and language", { skip: process.platform === "win32" }, async (t) => {
	const dir = await createTranscriptDir(t);
	const model = join(dir, "manual.bin");
	const cli = join(dir, "whisper-cli");
	await writeFile(model, "manual model fixture");
	await writeFile(cli, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[args.indexOf('-l') + 1] !== 'fr' || !args.includes('-tr') || args.includes('-ng')) process.exit(23);
process.stderr.write('whisper_backend_init_gpu: using Vulkan0 backend\\n');
process.stdout.write('fixed language/task');
`, { mode: 0o700 });
	const choice = { language: "fr", task: "translate-en", compute: "auto" };
	const result = await transcribeInstalledWhisper(cli, model, join(dir, "audio.wav"), new RecordingDirectory(dir), choice, new AbortController().signal);
	assert.deepEqual(result, { text: "fixed language/task", actualCompute: "vulkan", boundDevice: null });
});

test("installed Whisper does not report a probe-only Metal device as its loaded binding", { skip: process.platform === "win32" }, async (t) => {
	const dir = await createTranscriptDir(t);
	const model = join(dir, "manual.bin");
	const cli = join(dir, "whisper-cli");
	await writeFile(model, "manual model fixture");
	await writeFile(cli, `#!${process.execPath}
process.stderr.write('ggml_backend_metal_device_init: using default device\\nwhisper_backend_init_gpu: no GPU found\\n');
process.stdout.write('CPU transcript');
`, { mode: 0o700 });
	const choice = { language: "en", task: "transcribe", compute: "cpu" };
	const result = await transcribeInstalledWhisper(cli, model, join(dir, "audio.wav"), new RecordingDirectory(dir), choice, new AbortController().signal);
	assert.deepEqual(result, { text: "CPU transcript", actualCompute: "cpu", boundDevice: null });
});

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

test("a stdout transcript at the capture limit is returned in full", async (t) => {
	const dir = await createTranscriptDir(t);
	const transcript = await transcribeStdout(dir, MAX_CAPTURED_OUTPUT_CHARS);
	assert.equal(transcript, "a" + "x".repeat(MAX_CAPTURED_OUTPUT_CHARS - 1));
});

test("a truncated stdout fallback rejects instead of returning transcript text", async (t) => {
	const dir = await createTranscriptDir(t);
	await assert.rejects(transcribeStdout(dir, MAX_CAPTURED_OUTPUT_CHARS + 1), /stdout.*capture limit.*truncated/i);
});

test("a blank regular transcript cannot fall back to truncated stdout", async (t) => {
	const dir = await createTranscriptDir(t);
	await writeFile(join(dir, "transcript.txt"), " \t\n");
	await assert.rejects(transcribeStdout(dir, MAX_CAPTURED_OUTPUT_CHARS + 1), /stdout.*capture limit.*truncated/i);
});

test("an intact transcript file takes precedence over truncated stdout", async (t) => {
	const dir = await createTranscriptDir(t);
	await writeFile(join(dir, "transcript.txt"), "A complete transcript.\n");
	assert.equal(await transcribeStdout(dir, MAX_CAPTURED_OUTPUT_CHARS + 1), "A complete transcript.\n");
});
