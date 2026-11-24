import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkerPath = fileURLToPath(new URL("../../scripts/check-package-contents.mjs", import.meta.url));

// Run with npm exec -- node --test test/packaging/check-package-contents.test.mjs.
test("the package guard rejects a forbidden manifest entry without npm on PATH", async (t) => {
	const npmCli = process.env.npm_execpath;
	assert.ok(npmCli, "Run this packaging test through npm exec so npm_execpath is set.");
	const root = await mkdtemp(join(tmpdir(), "micme package guard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "pack-fixture", version: "1.0.0", files: ["micme.json"] }));
	await writeFile(join(root, "micme.json"), "{}");

	// Exclude both POSIX PATH and Windows Path spellings but keep the actual npm JavaScript CLI from npm exec.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
	const result = spawnSync(process.execPath, [checkerPath], {
		cwd: root,
		encoding: "utf8",
		env: { ...env, PATH: root },
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /^- micme\.json \(generated Micme config\)\r?$/m);
});
