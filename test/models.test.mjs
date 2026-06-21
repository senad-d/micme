import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { downloadFile } = await import("../src/models.ts");

async function withMockFetch(fetchImpl, fn) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("downloadFile writes streamed response to the target path", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-model-download-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const target = join(root, "ggml-test.bin");
	const encoder = new TextEncoder();

	await withMockFetch(
		async (url) => {
			assert.equal(url, "https://example.test/ggml-test.bin");
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode("hello "));
						controller.enqueue(encoder.encode("world"));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-length": "11" } },
			);
		},
		async () => {
			await downloadFile("https://example.test/ggml-test.bin", target);
		},
	);

	assert.equal(await readFile(target, "utf8"), "hello world");
});

test("downloadFile rejects when the target path already exists as a directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-model-download-dir-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const target = join(root, "ggml-test.bin");
	await mkdir(target);
	let fetchCalled = false;

	await withMockFetch(
		async () => {
			fetchCalled = true;
			throw new Error("fetch should not run");
		},
		async () => {
			await assert.rejects(downloadFile("https://example.test/ggml-test.bin", target), /exists but is not a file/);
		},
	);

	assert.equal(fetchCalled, false);
});

test("downloadFile removes the temporary file when the response stream fails", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-model-download-fail-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const target = join(root, "ggml-test.bin");
	const encoder = new TextEncoder();
	let reads = 0;

	await withMockFetch(
		async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => "7" },
			body: {
				getReader: () => ({
					async read() {
						if (reads++ === 0) return { done: false, value: encoder.encode("partial") };
						throw new Error("stream failed");
					},
					async cancel() {},
				}),
			},
		}),
		async () => {
			await assert.rejects(downloadFile("https://example.test/ggml-test.bin", target), /stream failed/);
		},
	);

	assert.equal(existsSync(target), false);
	assert.deepEqual(await readdir(root), []);
});
