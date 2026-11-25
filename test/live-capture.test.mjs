import assert from "node:assert/strict";
import { appendFile, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as capture from "../src/live-capture.ts";
import { createLiveRecordingDirectory, createRecordingDirectory } from "../src/recording-dir.ts";

async function makeDirectory(t) {
	const directory = await createLiveRecordingDirectory(".", false, "micme-live-test-");
	t.after(async () => {
		try {
			await directory.remove();
		} finally {
			directory.close();
		}
	});
	return directory;
}

function pcm(samples) {
	const bytes = Buffer.alloc(samples.length * 2);
	for (let index = 0; index < samples.length; index++) bytes.writeInt16LE(samples[index], index * 2);
	return bytes;
}

function wavHeader(dataBytes, { growing = false, ancillary = false, rate = 16_000 } = {}) {
	const junk = ancillary ? Buffer.from([74, 85, 78, 75, 3, 0, 0, 0, 17, 34, 51, 0]) : Buffer.alloc(0); // odd padded JUNK chunk
	const header = Buffer.alloc(44 + junk.length);
	header.write("RIFF");
	header.writeUInt32LE(growing ? 0xffffffff : header.length - 8 + dataBytes, 4);
	header.write("WAVE", 8);
	junk.copy(header, 12);
	const fmt = 12 + junk.length;
	header.write("fmt ", fmt);
	header.writeUInt32LE(16, fmt + 4);
	header.writeUInt16LE(1, fmt + 8);
	header.writeUInt16LE(1, fmt + 10);
	header.writeUInt32LE(rate, fmt + 12);
	header.writeUInt32LE(rate * 2, fmt + 16);
	header.writeUInt16LE(2, fmt + 20);
	header.writeUInt16LE(16, fmt + 22);
	header.write("data", fmt + 24);
	header.writeUInt32LE(growing ? 0xffffffff : dataBytes, fmt + 28);
	return header;
}

async function patchLengths(path, finalHeader) {
	const fd = await open(path, "r+");
	try {
		await fd.write(finalHeader.subarray(4, 8), 0, 4, 4);
		await fd.write(finalHeader.subarray(-4), 0, 4, finalHeader.length - 4);
	} finally {
		await fd.close();
	}
}

async function openReader(t, directory, path, signal = new AbortController().signal) {
	const reader = await capture.openLivePcm(path, directory, signal);
	t.after(() => reader.close());
	return reader;
}

const caughtUp = { pcm: Buffer.alloc(0), availableThrough: 0 };

test("partial RIFF and chunk headers, padding, and a split sample preserve the cursor through final drain", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	const header = wavHeader(0, { growing: true, ancillary: true });
	const samples = pcm([1234, -4321, 5678]);
	await writeFile(path, header.subarray(0, 7));
	const reader = await openReader(t, directory, path);
	assert.deepEqual(await reader.read(false), caughtUp);
	await appendFile(path, header.subarray(7, -2));
	assert.deepEqual(await reader.read(false), caughtUp);
	await appendFile(path, Buffer.concat([header.subarray(-2), samples.subarray(0, 3)]));
	assert.deepEqual(await reader.read(false), { pcm: samples.subarray(0, 2), availableThrough: 1 });
	assert.deepEqual(await reader.read(false), { pcm: caughtUp.pcm, availableThrough: 1 });
	await appendFile(path, samples.subarray(3));
	await patchLengths(path, wavHeader(samples.length, { ancillary: true }));
	assert.deepEqual(await reader.read(true), { pcm: samples.subarray(2), availableThrough: 3 });
	assert.deepEqual(await reader.read(true), { pcm: caughtUp.pcm, availableThrough: 3 });
});

test("a reader catches up from disk in blocks of at most 16000 samples", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	const bytes = pcm(Array.from({ length: 32_003 }, (_, index) => index - 16_000));
	await writeFile(path, Buffer.concat([wavHeader(bytes.length), bytes]));
	const reader = await openReader(t, directory, path);
	for (const [start, end] of [[0, 32_000], [32_000, 64_000], [64_000, bytes.length]]) {
		assert.deepEqual(await reader.read(true), { pcm: bytes.subarray(start, end), availableThrough: 32_003 });
	}
	assert.deepEqual(await reader.read(true), { pcm: caughtUp.pcm, availableThrough: 32_003 });
});

test("only a valid finalized zero-length WAV is empty speech", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	await writeFile(path, wavHeader(0));
	const reader = await openReader(t, directory, path);
	assert.deepEqual(await reader.read(true), caughtUp);
});

test("invalid format, incomplete data, and non-final lengths cannot produce a successful final drain", async (t) => {
	const directory = await makeDirectory(t);
	const samples = pcm([1]);
	for (const [name, contents, error] of [
		["wrong-rate", Buffer.concat([wavHeader(2, { rate: 44_100 }), samples]), /16 kHz mono/],
		["short-header", wavHeader(2).subarray(0, -1), /incomplete WAV header/i],
		["short-sample", Buffer.concat([wavHeader(2), samples.subarray(0, 1)]), /final WAV length/i],
		["unpatched", Buffer.concat([wavHeader(0, { growing: true }), samples]), /final WAV length/i],
	]) {
		const path = join(directory.path, `${name}.wav`);
		await writeFile(path, contents);
		const reader = await openReader(t, directory, path);
		await assert.rejects(reader.read(true), error);
		reader.close();
	}
});

test("live WAV metadata scans reject a chunk beyond the header limit without waiting for its body", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	const header = wavHeader(0, { growing: true, ancillary: true });
	header.writeUInt32LE(1024 * 1024, 16); // claimed JUNK size
	await writeFile(path, header.subarray(0, 20));
	const reader = await openReader(t, directory, path);
	await assert.rejects(reader.read(false), /metadata exceeds the live header limit/);
});

test("extensible WAV with the mono signed PCM subtype exposes only samples", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	const samples = pcm([2048, -4096]);
	const header = wavHeader(samples.length);
	const extension = Buffer.from("16001000040000000100000000001000800000aa00389b71", "hex");
	header.writeUInt32LE(header.readUInt32LE(4) + extension.length, 4);
	header.writeUInt32LE(16 + extension.length, 16);
	header.writeUInt16LE(0xfffe, 20);
	await writeFile(path, Buffer.concat([header.subarray(0, 36), extension, header.subarray(36), samples]));
	const reader = await openReader(t, directory, path);
	assert.deepEqual(await reader.read(true), { pcm: samples, availableThrough: 2 });
});

test("growing data cannot shrink behind the reader even if its cursor has not reached the lost tail", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	const header = wavHeader(0, { growing: true });
	const audio = Buffer.alloc(40_000);
	await writeFile(path, Buffer.concat([header, audio]));
	const reader = await openReader(t, directory, path);
	assert.equal((await reader.read(false)).availableThrough, 20_000);
	await writeFile(path, Buffer.concat([header, audio.subarray(0, 38_000)]));
	await assert.rejects(reader.read(false), /truncat/i);
});

test("abort interrupts missing-leaf polling and cancels later reads on an open spool", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	const waiting = new AbortController();
	const pending = capture.openLivePcm(path, directory, waiting.signal);
	const cancelled = assert.rejects(pending, { name: "AbortError" });
	await delay(25);
	waiting.abort();
	await cancelled;

	await writeFile(path, wavHeader(0));
	const reading = new AbortController();
	const reader = await openReader(t, directory, path, reading.signal);
	reading.abort();
	await assert.rejects(reader.read(false), { name: "AbortError" });
});

test("missing-leaf startup has a deadline and a capture setup hint", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	let first = true;
	t.mock.method(performance, "now", () => {
		if (!first) return Number.MAX_SAFE_INTEGER;
		first = false;
		return 0;
	});
	await assert.rejects(capture.openLivePcm(path, directory, t.signal), /timed out.*Use clip mode/);
});

test("live capture refuses unverified directory access even if the path points to a valid WAV", async (t) => {
	const directory = await createRecordingDirectory(".", false);
	t.after(() => directory.remove());
	const path = join(directory.path, "raw.wav");
	await writeFile(path, wavHeader(0));
	await assert.rejects(capture.openLivePcm(path, directory, t.signal), /could not verify.*use clip mode/);
	await assert.rejects(capture.buildLiveRecorderCommand(path, directory, t.signal), /verified recording directory.*use clip mode/);
});

test("refinement copies only the acknowledged decoder-ready payload from the original leaf after replacement", { skip: process.platform === "win32" }, async (t) => {
	const source = await makeDirectory(t);
	const target = await makeDirectory(t);
	const path = join(source.path, "raw.wav");
	const original = pcm([7183, -1134, 0, 2604]);
	const replacement = pcm([231, 0, -3183, 4126]);
	await writeFile(path, Buffer.concat([wavHeader(original.length, { ancillary: true }), original]));
	const reader = await openReader(t, source, path);
	assert.deepEqual(await reader.read(false), { pcm: original, availableThrough: 4 });
	await rename(path, join(source.path, "old.wav"));
	await writeFile(path, Buffer.concat([wavHeader(replacement.length), replacement]));
	assert.deepEqual(await reader.read(true), { pcm: caughtUp.pcm, availableThrough: 4 });

	const signal = new AbortController().signal;
	await assert.rejects(reader.writeRefinementInput(target, 3, signal), /acknowledged|count/);
	const snapshot = await reader.writeRefinementInput(target, 4, signal);
	assert.equal(snapshot, join(target.filesPath, "refinement.wav"));
	const readablePath = target.cwdFd === undefined ? snapshot : join(target.path, snapshot);
	assert.deepEqual(await readFile(readablePath), Buffer.concat([wavHeader(original.length), original]));
	await assert.rejects(reader.writeRefinementInput(target, 4, signal), { code: "EEXIST" });
});

test("same-inode same-length payload rewrites fail identity verification", async (t) => {
	const source = await makeDirectory(t);
	const target = await makeDirectory(t);
	const path = join(source.path, "raw.wav");
	const header = wavHeader(4);
	const original = pcm([1, 2]);
	await writeFile(path, Buffer.concat([header, original]));
	const reader = await openReader(t, source, path);
	assert.deepEqual(await reader.read(true), { pcm: original, availableThrough: 2 });
	assert.deepEqual(await reader.read(true), { pcm: caughtUp.pcm, availableThrough: 2 });
	const fd = await open(path, "r+");
	try {
		await fd.write(pcm([3, 4]), 0, 4, header.length);
	} finally {
		await fd.close();
	}
	await assert.rejects(reader.writeRefinementInput(target, 2, new AbortController().signal), /changed|digest/i);
});

test("refinement revalidates the original WAV header after final drain", async (t) => {
	const source = await makeDirectory(t);
	const target = await makeDirectory(t);
	const path = join(source.path, "raw.wav");
	const bytes = pcm([716]);
	await writeFile(path, Buffer.concat([wavHeader(bytes.length), bytes]));
	const reader = await openReader(t, source, path);
	await reader.read(true);
	await reader.read(true);
	const fd = await open(path, "r+");
	try {
		const badFormat = wavHeader(bytes.length, { rate: 44_100 });
		await fd.write(badFormat, 0, badFormat.length, 0);
	} finally {
		await fd.close();
	}
	await assert.rejects(reader.writeRefinementInput(target, 1, t.signal), /16 kHz mono/);
});

test("closing during a pending read defers handle close until the read settles and yields no PCM", async (t) => {
	const directory = await makeDirectory(t);
	const path = join(directory.path, "raw.wav");
	const reading = Promise.withResolvers();
	const release = Promise.withResolvers();
	const header = wavHeader(0);
	const close = t.mock.fn();
	t.mock.method(directory, "openVerifiedFile", () => ({
		size: () => header.length,
		readAt: async (bytes, offset) => {
			assert.equal(offset, 0, "closing must prevent scheduling additional reads");
			reading.resolve();
			await release.promise;
			return header.copy(bytes, 0, offset, offset + bytes.length);
		},
		close,
	}));
	const reader = await openReader(t, directory, path);
	const rejected = assert.rejects(reader.read(true), /closed/);
	await reading.promise;
	reader.close();
	assert.equal(close.mock.callCount(), 0);
	release.resolve();
	await rejected;
	reader.close();
	assert.equal(close.mock.callCount(), 1);
});
