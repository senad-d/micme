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
const helperSources = [
	"native/recognizer/CMakeLists.txt",
	"native/recognizer/instrument.cmake",
	"native/recognizer/main.cpp",
	"native/recognizer/README.md",
	"native/polish/apple-final.swift",
];
const forbiddenFiles = [
	["micme.json", "generated Micme config"],
	["native/live/build/CMakeCache.txt", "unexpected native files"],
	["native/live/worker-contract.test.mjs", "unexpected native files"],
	["native/recognizer/micme-recognizer", "unexpected native files"],
	["native/polish/apple-final", "unexpected native files"],
	["dist/doctor/src/extension.js", "extension in headless build"],
	["fixtures/micme-fixture.json", "test fixtures"],
	["models/model.safetensors", "model artifacts"],
	["build/live/CMakeCache.txt", "local build products"],
	["bin/micme-live", "local build products"],
	["bin/micme-live.exe", "local build products"],
	["bin/micme-recognizer", "local build products"],
	["models/ggml-silero-v5.1.2.bin", "model artifacts"],
	["recordings/sample.wav", "audio artifacts"],
];

async function stagePackage(t, { includeForbidden = false, editManifest } = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme package guard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
	// Only exercise npm's packlist here; stub the inputs, including the normally built doctor target.
	delete manifest.scripts;
	const forbiddenPaths = forbiddenFiles.map(([path]) => path);
	if (includeForbidden) manifest.files.push(...forbiddenPaths);
	const declaredPaths = [...manifest.pi.extensions, ...Object.values(manifest.bin)];
	editManifest?.(manifest);
	await writeFile(join(root, "package.json"), JSON.stringify(manifest));
	// Simulate an accidentally emitted extension only for the explicit negative case.
	const stagedArtifacts = includeForbidden ? forbiddenPaths : forbiddenPaths.filter((path) => path !== "dist/doctor/src/extension.js");
	for (const path of [...declaredPaths, ...workerSources, ...helperSources, ...stagedArtifacts]) {
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
	for (const source of [...workerSources, ...helperSources]) assert.ok(packed.has(`- ${source}`), result.stdout);
	for (const [path] of forbiddenFiles) assert.ok(!packed.has(`- ${path}`), result.stdout);
});

test("the package guard rejects forbidden manifest entries without npm on PATH", async (t) => {
	const result = checkWithoutNpmOnPath(await stagePackage(t, { includeForbidden: true }));
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.doesNotMatch(result.stderr, /^Missing required package paths:\r?$/m);
	const violations = new Set(result.stderr.split(/\r?\n/));
	for (const [path, label] of forbiddenFiles) assert.ok(violations.has(`- ${path} (${label})`), result.stderr);
});

test("the package guard requires the public transcription bin declaration", async (t) => {
	const result = checkWithoutNpmOnPath(await stagePackage(t, { editManifest(manifest) { delete manifest.bin["micme-transcribe"]; } }));
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /micme-transcribe.*dist\/doctor\/scripts\/transcribe\.mjs/);
});

test("the package guard requires the packaged helper build inputs", async (t) => {
	const missing = "native/recognizer/instrument.cmake";
	const result = checkWithoutNpmOnPath(await stagePackage(t, { editManifest(manifest) { manifest.files = manifest.files.filter((path) => path !== missing); } }));
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /Missing required package paths:\s+- native\/recognizer\/instrument\.cmake/);
});

test("the package guard keeps Pi dependencies out of a standalone install", async (t) => {
	const result = checkWithoutNpmOnPath(await stagePackage(t, { editManifest(manifest) {
		manifest.dependencies["@earendil-works/pi-coding-agent"] = "*";
		delete manifest.peerDependenciesMeta["@earendil-works/pi-tui"];
	} }));
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /@earendil-works\/pi-coding-agent must not be a runtime dependency/);
	assert.match(result.stderr, /@earendil-works\/pi-tui must be an optional peer/);
});

test("the package guard forbids install hooks in the headless package", async (t) => {
	const result = checkWithoutNpmOnPath(await stagePackage(t, { editManifest(manifest) { manifest.scripts = { install: "false" }; } }));
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /install lifecycle hook/);
});
