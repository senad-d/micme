import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reloadMicmeConfig } from "../src/config.ts";
import { ensureWhisperCppModel, resolveWhisperCppModel } from "../src/models.ts";
import { getManagedWhisperVariant } from "../src/transfer/catalog.ts";
import { ensureManaged, ensurePinnedModelFile, removeManaged, removePinnedModelFiles } from "../src/transfer/managed.ts";

const contents = "verified model bytes";
const blob = {
	path: "ggml-fixture.bin",
	revision: "b".repeat(40),
	url: `https://models.example.test/resolve/${"b".repeat(40)}/ggml-fixture.bin`,
	bytes: contents.length,
	sha256: createHash("sha256").update(contents).digest("hex"),
};
const prefix = "verified ";
const offset = prefix.length;
const range = `bytes=${offset}-`;
const signal = new AbortController().signal;
const noop = () => {};

async function setup(t) {
	const root = await mkdtemp(join(tmpdir(), "micme-managed-"));
	const settings = {
		PI_CODING_AGENT_DIR: root, MICME_MODEL_DIR: root, MICME_AUTO_DOWNLOAD_MODEL: "1",
		MICME_WHISPER_CPP_MODEL: undefined, MICME_VAD_MODEL: undefined,
	};
	const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
	t.after(async () => {
		setSettings(previous);
		await rm(root, { recursive: true, force: true });
	});
	setSettings(settings);
	return { root, target: join(root, blob.path) };
}

function setSettings(settings) {
	for (const [key, value] of Object.entries(settings)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	reloadMicmeConfig();
}

function interruptAfterPrefix() {
	return new Response(new ReadableStream({
		start(controller) { controller.enqueue(Buffer.from(prefix)); },
	}));
}

async function checkpoint(target) {
	const source = new AbortController();
	const interrupted = ensurePinnedModelFile(blob, target, {
		signal: source.signal,
		onProgress(got) { if (got === offset) source.abort(); },
	});
	await assert.rejects(interrupted, { name: "AbortError" });
	await assert.rejects(readFile(target), { code: "ENOENT" });
}

function responseForRange() {
	return new Response(contents.slice(offset), {
		status: 206,
		headers: { "Content-Range": `bytes ${offset}-${blob.bytes - 1}/${blob.bytes}` },
	});
}

function removeFixture(target, removalSignal = signal) {
	removePinnedModelFiles([{ blob, target }], removalSignal);
}

test("a completed managed transfer publishes exact bytes and re-verifies them offline", async (t) => {
	const { target } = await setup(t);
	const events = [];
	const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(url, blob.url);
		assert.equal(options.headers.Range, undefined);
		return new Response(contents);
	});
	await ensurePinnedModelFile(blob, target, {
		onProgress(got, total) { events.push([got, total]); },
	});
	assert.equal(await readFile(target, "utf8"), contents);
	assert.deepEqual(events[0], [0, blob.bytes]);
	assert.deepEqual(events.at(-1), [blob.bytes, blob.bytes]);
	await ensurePinnedModelFile(blob, target, { missing: "no network" });
	assert.equal(fetch.mock.callCount(), 1);
});

test("a same-size corrupt cache entry is rejected without network or destructive repair", async (t) => {
	const { target } = await setup(t);
	const corrupt = "x".repeat(blob.bytes);
	await writeFile(target, corrupt);
	t.mock.method(globalThis, "fetch", () => assert.fail("a bad cache leaf must not be silently repaired"));
	await assert.rejects(ensurePinnedModelFile(blob, target, {}), /SHA-256 mismatch/);
	assert.equal(await readFile(target, "utf8"), corrupt);
});

test("a symlink to valid bytes is not a managed cache hit or removal target", { skip: process.platform === "win32" }, async (t) => {
	const { root, target } = await setup(t);
	const manual = join(root, "manual.bin");
	await writeFile(manual, contents);
	await symlink(manual, target);
	t.mock.method(globalThis, "fetch", () => assert.fail("a symlink is not a missing cache entry"));
	await assert.rejects(ensurePinnedModelFile(blob, target, {}), { code: "unsafe" });
	assert.throws(() => removeFixture(target), { code: "unsafe" });
	assert.equal(await readFile(manual, "utf8"), contents);
});

test("a cancelled transfer resumes at its saved offset only with the exact 206", async (t) => {
	const { target } = await setup(t);
	const requests = [];
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		requests.push(options.headers.Range);
		return requests.length === 1 ? interruptAfterPrefix() : responseForRange();
	});
	await checkpoint(target);
	await ensurePinnedModelFile(blob, target, {});
	assert.deepEqual(requests, [undefined, range]);
	assert.equal(await readFile(target, "utf8"), contents);
});

test("a full response from a range-less proxy restarts at zero rather than appending", async (t) => {
	const { target } = await setup(t);
	const requests = [];
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		requests.push(options.headers.Range);
		return requests.length === 1 ? interruptAfterPrefix() : new Response(contents);
	});
	await checkpoint(target);
	await ensurePinnedModelFile(blob, target, {});
	assert.deepEqual(requests, [undefined, range]);
	assert.equal(await readFile(target, "utf8"), contents);
});

test("an incorrect Content-Range is discarded before one full retry", async (t) => {
	const { target } = await setup(t);
	const requests = [];
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		requests.push(options.headers.Range);
		if (requests.length === 1) return interruptAfterPrefix();
		if (requests.length === 2) return new Response(contents.slice(offset), { status: 206, headers: { "Content-Range": `bytes ${offset}-${blob.bytes - 1}/${blob.bytes + 1}` } });
		return new Response(contents);
	});
	await checkpoint(target);
	await ensurePinnedModelFile(blob, target, {});
	assert.deepEqual(requests, [undefined, range, undefined]);
	assert.equal(await readFile(target, "utf8"), contents);
});

test("an invalid range clears its checkpoint even if the full retry also fails", async (t) => {
	const { target } = await setup(t);
	const requests = [];
	t.mock.method(globalThis, "fetch", async (_url, { headers }) => {
		requests.push(headers.Range);
		if (requests.length === 1) return interruptAfterPrefix();
		if (requests.length < 4) return new Response(null, { status: 416 });
		return new Response(contents);
	});
	await checkpoint(target);
	await assert.rejects(ensurePinnedModelFile(blob, target, {}), /HTTP 416/);
	await assert.rejects(readFile(target), { code: "ENOENT" });
	await ensurePinnedModelFile(blob, target, {});
	assert.deepEqual(requests, [undefined, range, undefined, undefined]);
});

test("a checkpoint for a stale pin is not used for a different immutable blob", async (t) => {
	const { target } = await setup(t);
	const requestRanges = [];
	t.mock.method(globalThis, "fetch", async (_url, { headers }) => {
		requestRanges.push(headers.Range);
		return requestRanges.length === 1 ? interruptAfterPrefix() : new Response(contents);
	});
	await checkpoint(target);
	await ensurePinnedModelFile({ ...blob, revision: "a".repeat(40), url: blob.url.replace(blob.revision, "a".repeat(40)) }, target, {});
	assert.deepEqual(requestRanges, [undefined, undefined]);
	assert.equal(await readFile(target, "utf8"), contents);
});

test("a spontaneous 206 without an authorized range never makes a model ready", async (t) => {
	const { target } = await setup(t);
	t.mock.method(globalThis, "fetch", async () => responseForRange());
	await assert.rejects(ensurePinnedModelFile(blob, target, {}), /unexpected HTTP status or byte range/);
	await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("a cancelled waiter leaves a shared verified install running for its peer", async (t) => {
	const { target } = await setup(t);
	const first = new AbortController();
	let fetchSignal;
	const ready = Promise.withResolvers();
	const peerWaiting = Promise.withResolvers();
	const body = Promise.withResolvers();
	const fetch = t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
		fetchSignal = signal;
		ready.resolve();
		return body.promise;
	});
	const cancelled = ensurePinnedModelFile(blob, target, { signal: first.signal });
	const kept = ensurePinnedModelFile(blob, target, { onWait: peerWaiting.resolve });
	await Promise.all([ready.promise, peerWaiting.promise]);
	first.abort();
	await assert.rejects(cancelled, { name: "AbortError" });
	assert.equal(fetchSignal.aborted, false);
	await assert.rejects(readFile(target), { code: "ENOENT" });
	body.resolve(new Response(contents));
	await kept;
	assert.equal(fetch.mock.callCount(), 1);
	assert.equal(await readFile(target, "utf8"), contents);
});

test("publication does not overwrite a manual file that appeared during transfer", async (t) => {
	const { target } = await setup(t);
	t.mock.method(globalThis, "fetch", async () => {
		await writeFile(target, "manual");
		return new Response(contents);
	});
	await assert.rejects(ensurePinnedModelFile(blob, target, {}), /size mismatch/);
	assert.equal(await readFile(target, "utf8"), "manual");
	assert.throws(() => removeFixture(target), { code: "unowned" });
});

test("publication refuses to write through a switched cache directory", async (t) => {
	const { root } = await setup(t);
	const cache = join(root, "cache");
	const target = join(cache, blob.path);
	const moved = join(root, "original");
	let replaced = false;
	t.mock.method(globalThis, "fetch", async () => new Response(contents));
	await assert.rejects(ensurePinnedModelFile(blob, target, {
		onProgress(got) {
			if (!got || replaced) return;
			renameSync(cache, moved);
			mkdirSync(cache);
			replaced = true;
		},
	}), { code: "unsafe" });
	assert.equal(replaced, true);
	await assert.rejects(readFile(target), { code: "ENOENT" });
	await assert.rejects(readFile(join(moved, blob.path)), { code: "ENOENT" });
});

test("confirmed removal discards a parked checkpoint without creating a model", async (t) => {
	const { root, target } = await setup(t);
	t.mock.method(globalThis, "fetch", async () => interruptAfterPrefix());
	await checkpoint(target);
	removeFixture(target);
	assert.deepEqual(await readdir(root), []);
});

test("confirmed removal can repair a corrupt owned file but refuses a replacement inode", async (t) => {
	const { root, target } = await setup(t);
	t.mock.method(globalThis, "fetch", async () => new Response(contents));
	await ensurePinnedModelFile(blob, target, {});
	await writeFile(target, "corrupt");
	removeFixture(target);
	assert.deepEqual(await readdir(root), []);
	await ensurePinnedModelFile(blob, target, {});
	await rename(target, join(root, "moved.bin"));
	await writeFile(target, contents);
	assert.throws(() => removeFixture(target), { code: "unowned" });
	assert.equal(await readFile(target, "utf8"), contents);
});

test("removal never touches a configured explicit path even if Micme previously installed it", async (t) => {
	const { target } = await setup(t);
	t.mock.method(globalThis, "fetch", async () => new Response(contents));
	await ensurePinnedModelFile(blob, target, {});
	setSettings({ MICME_WHISPER_CPP_MODEL: target });
	assert.throws(() => removeFixture(target), /explicit model path/);
	assert.equal(await readFile(target, "utf8"), contents);
});

test("an explicit ASR path at the standard location remains manual, even if missing", async (t) => {
	const { root } = await setup(t);
	const target = join(root, "ggml-tiny.bin");
	setSettings({ MICME_WHISPER_CPP_MODEL: target });
	t.mock.method(globalThis, "fetch", () => assert.fail("explicit paths must not initiate a download"));
	assert.equal(resolveWhisperCppModel().downloadable, false);
	await assert.rejects(ensureWhisperCppModel(target), /user-managed file/);
	await writeFile(target, "manual model bytes");
	await ensureWhisperCppModel(target);
});

test("the catalog service requires an exact qualified pin and honors offline authorization", async (t) => {
	const { root } = await setup(t);
	const variant = getManagedWhisperVariant("tiny");
	const forged = { ...variant, blobs: [{ ...variant.blobs[0], url: blob.url }] };
	t.mock.method(globalThis, "fetch", () => assert.fail("invalid, offline or disabled requests must not contact the network"));
	await assert.rejects(ensureManaged(forged, true, noop, signal), { code: "unqualified" });
	await assert.rejects(ensureManaged(variant, false, noop, signal), /Authorize the download/);
	setSettings({ MICME_AUTO_DOWNLOAD_MODEL: "0" });
	await assert.rejects(ensureManaged(variant, true, noop, signal), /auto-download is disabled/);
	assert.deepEqual(await readdir(root), []);
	const preseeded = join(root, variant.blobs[0].path);
	await writeFile(preseeded, "user file");
	await assert.rejects(removeManaged(variant, signal), { code: "unowned" });
	assert.equal(await readFile(preseeded, "utf8"), "user file");
});
