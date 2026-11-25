import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkerPath = fileURLToPath(new URL("../../scripts/check-package-contents.mjs", import.meta.url));
const workerSources = [
	"native/live/CMakeLists.txt",
	"native/live/main.cpp",
	"native/live/decoder.cpp",
	"native/live/decoder.hpp",
];
const forbiddenFiles = [
	["micme.json", "generated Micme config"],
	["native/live/build/CMakeCache.txt", "unexpected native files"],
	["native/live/worker-contract.test.mjs", "unexpected native files"],
	["build/live/CMakeCache.txt", "local build products"],
	["bin/micme-live", "local build products"],
	["bin/micme-live.exe", "local build products"],
	["models/ggml-silero-v5.1.2.bin", "model artifacts"],
	["recordings/sample.wav", "audio artifacts"],
];

async function stagePackage(t, { includeForbidden = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme package guard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
	// Only exercise npm's packlist here; stub the inputs, including the normally built doctor target.
	delete manifest.scripts;
	const forbiddenPaths = forbiddenFiles.map(([path]) => path);
	if (includeForbidden) manifest.files.push(...forbiddenPaths);
	await writeFile(join(root, "package.json"), JSON.stringify(manifest));
	for (const path of [...manifest.pi.extensions, ...Object.values(manifest.bin), ...workerSources, ...forbiddenPaths]) {
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, "fixture\n");
	}
	return root;
}

function checkWithoutNpmOnPath(root) {
	assert.ok(process.env.npm_execpath, "Run this packaging test through npm exec so npm_execpath is set.");

	// Exclude both POSIX PATH and Windows Path spellings but keep the actual npm JavaScript CLI from npm exec.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
	const result = spawnSync(process.execPath, [checkerPath], {
		cwd: root,
		encoding: "utf8",
		env: { ...env, PATH: root },
		timeout: 30_000,
	});
	assert.ifError(result.error);
	return result;
}

// Run with npm exec -c 'node --test test/packaging/check-package-contents.test.mjs'.
test("the npm allowlist packs worker sources and excludes local artifacts", async (t) => {
	const result = checkWithoutNpmOnPath(await stagePackage(t));
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const packed = new Set(result.stdout.split(/\r?\n/));
	for (const source of workerSources) assert.ok(packed.has(`- ${source}`), result.stdout);
	for (const [path] of forbiddenFiles) assert.ok(!packed.has(`- ${path}`), result.stdout);
});

test("the package guard rejects forbidden manifest entries without npm on PATH", async (t) => {
	const result = checkWithoutNpmOnPath(await stagePackage(t, { includeForbidden: true }));
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.doesNotMatch(result.stderr, /^Missing required package paths:\r?$/m);
	const violations = new Set(result.stderr.split(/\r?\n/));
	for (const [path, label] of forbiddenFiles) assert.ok(violations.has(`- ${path} (${label})`), result.stderr);
});
