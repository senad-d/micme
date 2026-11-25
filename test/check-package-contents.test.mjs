import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkerPath = fileURLToPath(new URL("../scripts/check-package-contents.mjs", import.meta.url));
const workerSources = [
	"native/live/CMakeLists.txt",
	"native/live/main.cpp",
	"native/live/decoder.cpp",
	"native/live/decoder.hpp",
];
const extensionPath = "src/extension.ts";
const doctorPath = "bin/doctor.mjs";
const packageFiles = [extensionPath, doctorPath, ...workerSources];
const doctorBin = { "micme-doctor": `./${doctorPath}` };

async function checkPackage(t, { files = packageFiles, bin = doctorBin }) {
	const root = await mkdtemp(join(tmpdir(), "micme-package-entrypoints-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"));
	await mkdir(join(root, "bin"));
	await mkdir(join(root, "native", "live"), { recursive: true });
	await writeFile(join(root, extensionPath), "export default function activate() {}\n");
	await writeFile(join(root, doctorPath), "#!/usr/bin/env node\n");
	for (const source of workerSources) await writeFile(join(root, source), "# fixture\n");
	await writeFile(join(root, "package.json"), JSON.stringify({
		name: "pack-fixture",
		version: "1.0.0",
		files,
		pi: { extensions: [`./${extensionPath}`] },
		bin,
	}));

	const result = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: "utf8", timeout: 30_000 });
	assert.ifError(result.error);
	return result;
}

function assertOnlyMissing(result, path) {
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.ok(!result.stdout.split(/\r?\n/).includes(`- ${path}`), result.stdout);
	assert.deepEqual(result.stderr.trim().split(/\r?\n/), ["Missing required package paths:", `- ${path}`]);
}

test("package guard rejects a Pi extension left out of the package files list", async (t) => {
	const result = await checkPackage(t, { files: packageFiles.filter((path) => path !== extensionPath) });
	assertOnlyMissing(result, extensionPath);
});

for (const [form, bin] of [
	["map", { ...doctorBin, "micme-tools": "./bin/tools.mjs" }],
	["string", "./bin/tools.mjs"],
]) {
	test(`package guard rejects a missing npm bin target declared as a ${form}`, async (t) => {
		const result = await checkPackage(t, { bin });
		assert.match(result.stdout, /^- src\/extension\.ts\r?$/m);
		assertOnlyMissing(result, "bin/tools.mjs");
	});
}

for (const source of workerSources) {
	test(`package guard requires ${source} in the packed manifest`, async (t) => {
		const result = await checkPackage(t, { files: packageFiles.filter((path) => path !== source) });
		assertOnlyMissing(result, source);
	});
}
