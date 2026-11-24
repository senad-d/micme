import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkerPath = fileURLToPath(new URL("../scripts/check-package-contents.mjs", import.meta.url));

async function checkPackage(t, { files, bin }) {
	const root = await mkdtemp(join(tmpdir(), "micme-package-entrypoints-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"));
	await mkdir(join(root, "bin"));
	await writeFile(join(root, "src", "extension.ts"), "export default function activate() {}\n");
	await writeFile(join(root, "bin", "doctor.mjs"), "#!/usr/bin/env node\n");
	await writeFile(join(root, "package.json"), JSON.stringify({
		name: "pack-fixture",
		version: "1.0.0",
		files,
		pi: { extensions: ["./src/extension.ts"] },
		bin,
	}));

	const result = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: "utf8", timeout: 30_000 });
	assert.ifError(result.error);
	return result;
}

test("package guard rejects a Pi extension left out of the package files list", async (t) => {
	const result = await checkPackage(t, { files: ["bin/doctor.mjs"], bin: { "micme-doctor": "./bin/doctor.mjs" } });
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.doesNotMatch(result.stdout, /^- src\/extension\.ts\r?$/m);
	assert.match(result.stderr, /^- src\/extension\.ts\r?$/m);
});

for (const [form, bin] of [
	["map", { "micme-doctor": "./bin/doctor.mjs", "micme-tools": "./bin/tools.mjs" }],
	["string", "./bin/tools.mjs"],
]) {
	test(`package guard rejects a missing npm bin target declared as a ${form}`, async (t) => {
		const result = await checkPackage(t, { files: ["src/**/*.ts", "bin/doctor.mjs"], bin });
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /^- src\/extension\.ts\r?$/m);
		assert.match(result.stderr, /^- bin\/tools\.mjs\r?$/m);
	});
}
