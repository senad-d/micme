import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { reloadMicmeConfig } = await import("../src/config.ts");
const {
	describeWhisperModel,
	discoverPythonWhisperModels,
	discoverWhisperCppModels,
	downloadFile,
	ensureWhisperCppModel,
	formatBytes,
	formatDownloadProgress,
	getDefaultWhisperCppModelPath,
	getDownloadableWhisperCppModelName,
	getPythonWhisperModelName,
	getWhisperCppModelCacheDir,
	getWhisperCppModelNameFromPath,
	getWhisperCppModelUrl,
	isDownloadableWhisperCppModelPath,
	isEnglishOnlyWhisperModelName,
	isKnownWhisperCppModelName,
	isTranslationUnsupportedWhisperModelName,
	queryPythonWhisperModelNames,
	resolveWhisperCppModel,
	scanModelDirectory,
	scanModelFiles,
	toMultilingualWhisperModelName,
	toTranslationCapableWhisperModelName,
	uniqueModelNames,
} = await import("../src/models.ts");

async function withMockFetch(fetchImpl, fn) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	reloadMicmeConfig();
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		reloadMicmeConfig();
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

test("model discovery scans configured, project, and cache paths", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-model-discovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const modelDir = join(root, "cache");
	await mkdir(join(cwd, "models", "nested"), { recursive: true });
	await mkdir(join(cwd, ".micme", "models"), { recursive: true });
	await mkdir(modelDir, { recursive: true });
	await writeFile(join(cwd, "models", "ggml-project.bin"), "project");
	await writeFile(join(cwd, "models", "nested", "ggml-nested.gguf"), "nested");
	await writeFile(join(cwd, ".micme", "models", "ggml-hidden.bin"), "hidden");
	await writeFile(join(modelDir, "ggml-base.en.bin"), "cache");
	await writeFile(join(modelDir, "notes.txt"), "ignored");

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_MODEL_DIR: modelDir,
			MICME_WHISPER_CPP_MODEL: join(root, "missing", "ggml-custom.bin"),
		},
		async () => {
			const scanned = scanModelFiles(cwd).map((path) => path.slice(root.length + 1)).sort();
			const manualScan = [];
			scanModelDirectory(join(root, "missing-dir"), manualScan, 0);
			scanModelDirectory(join(cwd, "models"), manualScan, 4);
			const candidates = discoverWhisperCppModels(cwd);
			const values = candidates.map((candidate) => candidate.value);

			assert.deepEqual(manualScan, []);
			assert.ok(scanned.includes("cache/ggml-base.en.bin"));
			assert.ok(scanned.includes("project/models/ggml-project.bin"));
			assert.ok(scanned.includes("project/models/nested/ggml-nested.gguf"));
			assert.ok(scanned.includes("project/.micme/models/ggml-hidden.bin"));
			assert.ok(values.includes(join(root, "missing", "ggml-custom.bin")));
			assert.ok(values.includes(join(modelDir, "ggml-small.en.bin")));
			assert.equal(candidates.find((candidate) => candidate.value.endsWith("ggml-base.en.bin"))?.installed, true);
		},
	);
});

test("model helper functions resolve translation-aware names and formatting", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-model-helpers-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const modelDir = join(root, "models");

	await withEnv(
		{
			PI_CODING_AGENT_DIR: join(root, "agent"),
			MICME_MODEL_DIR: modelDir,
			MICME_DEFAULT_WHISPER_CPP_MODEL: "large-v3-turbo",
			MICME_TRANSLATE_TO_ENGLISH: "bs",
			MICME_WHISPER_MODEL: "tiny.en",
		},
		async () => {
			const resolved = resolveWhisperCppModel();
			assert.equal(resolved.modelName, "large-v3");
			assert.equal(resolved.translationFallbackFrom, "large-v3-turbo");
			assert.equal(getDefaultWhisperCppModelPath(), join(modelDir, "ggml-large-v3.bin"));
			assert.equal(getWhisperCppModelCacheDir(), modelDir);
			assert.equal(getPythonWhisperModelName(), "tiny");
		},
	);

	assert.equal(describeWhisperModel("tiny.en"), "fastest, lowest accuracy");
	assert.equal(describeWhisperModel("base"), "fast baseline");
	assert.equal(describeWhisperModel("small"), "recommended stronger local model");
	assert.equal(describeWhisperModel("medium"), "stronger, slower");
	assert.equal(describeWhisperModel("large-v3-turbo"), "large-v3 turbo, strong but larger");
	assert.equal(describeWhisperModel("large-v3"), "highest accuracy, slowest/largest");
	assert.equal(describeWhisperModel("unknown"), "Whisper model");
	assert.equal(toMultilingualWhisperModelName("base.en"), "base");
	assert.equal(toTranslationCapableWhisperModelName("large-v3-turbo"), "large-v3");
	assert.equal(isEnglishOnlyWhisperModelName("base.en"), true);
	assert.equal(isTranslationUnsupportedWhisperModelName("turbo"), true);
	assert.equal(isTranslationUnsupportedWhisperModelName(undefined), false);
	assert.deepEqual(uniqueModelNames([" base ", "", "base", "small"]), ["base", "small"]);
	assert.equal(getWhisperCppModelNameFromPath("/tmp/ggml-small.en.gguf"), "small.en");
	assert.equal(getDownloadableWhisperCppModelName("/tmp/ggml-tiny.bin"), "tiny");
	assert.equal(getDownloadableWhisperCppModelName("/tmp/ggml-not-real.bin"), undefined);
	assert.equal(isDownloadableWhisperCppModelPath("/tmp/ggml-tiny.bin"), true);
	assert.equal(isKnownWhisperCppModelName("small"), true);
	assert.equal(isKnownWhisperCppModelName("not-real"), false);
	assert.match(getWhisperCppModelUrl("tiny"), /ggml-tiny\.bin$/);
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1536), "1.5 KB");
	assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
	assert.equal(formatDownloadProgress(50, 100), "50% (50 B/100 B)");
	assert.equal(formatDownloadProgress(2048, 0), "2.0 KB");
});

test("Python Whisper model discovery uses PATH results and built-in fallback", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-python-models-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	await mkdir(bin);
	const python = join(bin, "python3");
	await writeFile(python, "#!/bin/sh\nprintf 'small\\nbase\\nsmall\\n'\n");
	await chmod(python, 0o755);

	await withEnv({ PATH: bin }, async () => {
		assert.deepEqual(await queryPythonWhisperModelNames(), ["small", "base"]);
		const candidates = await discoverPythonWhisperModels();
		assert.deepEqual(candidates.map((candidate) => candidate.value), ["small", "base"]);
		assert.equal(candidates[0]?.installed, true);
	});

	await withEnv({ PATH: join(root, "missing-bin") }, async () => {
		const fallback = await discoverPythonWhisperModels();
		assert.equal(fallback[0]?.installed, false);
		assert.ok(fallback.some((candidate) => candidate.value === "base.en"));
	});
});

test("ensureWhisperCppModel validates targets and downloads standard models", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-ensure-model-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const target = join(root, "models", "ggml-tiny.bin");
	const statuses = [];
	const notifications = [];
	const ctx = {
		ui: {
			setStatus(key, value) {
				statuses.push({ key, value });
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};

	await withEnv({ PI_CODING_AGENT_DIR: join(root, "agent"), MICME_AUTO_DOWNLOAD_MODEL: "1" }, async () => {
		await withMockFetch(
			async (url) => {
				assert.match(String(url), /ggml-tiny\.bin$/);
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("tiny model"));
							controller.close();
						},
					}),
					{ status: 200, headers: { "content-length": "10" } },
				);
			},
			async () => {
				await ensureWhisperCppModel(target, ctx);
			},
		);
		assert.equal(await readFile(target, "utf8"), "tiny model");
		await ensureWhisperCppModel(target, ctx);
	});

	await mkdir(join(root, "directory-target"));
	await assert.rejects(ensureWhisperCppModel(join(root, "directory-target")), /exists but is not a file/);
	await withEnv({ MICME_AUTO_DOWNLOAD_MODEL: "0" }, async () => {
		await assert.rejects(ensureWhisperCppModel(join(root, "models", "ggml-base.bin")), /auto-download is disabled/);
	});
	await assert.rejects(ensureWhisperCppModel(join(root, "models", "custom-model.bin"), undefined, { allowDownload: false }), /Micme model is missing/);
	await withMockFetch(
		async () => new Response(null, { status: 404, statusText: "Not Found" }),
		async () => {
			await assert.rejects(downloadFile("https://example.test/missing.bin", join(root, "missing.bin")), /HTTP 404 Not Found/);
		},
	);

	assert.ok(statuses.some((entry) => entry.value?.includes("downloading ggml-tiny.bin")));
	assert.ok(statuses.some((entry) => entry.value === undefined));
	assert.ok(notifications.some((entry) => entry.message.includes("Downloaded ggml-tiny.bin")));
});
