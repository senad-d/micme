import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function runNpm(args, cwd, env = process.env) {
	const npmCli = process.env.npm_execpath;
	assert.ok(npmCli, "Run with npm exec -- node --test test/packaging/doctor.test.mjs");
	const result = spawnSync(process.execPath, [npmCli, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...env, PATH: [dirname(process.execPath), env.PATH].join(delimiter) },
		timeout: 120_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `npm ${args[0]} failed:\n${result.stderr}\n${result.stdout}`);
	return result.stdout;
}

// Run separately from npm test: the fresh install can need registry access.
test("the npm-installed micme-doctor bin prints its banner", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-install-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	await mkdir(project);

	const [{ filename }] = JSON.parse(runNpm(["pack", "--json", "--pack-destination", root], packageRoot));
	runNpm(["install", "--no-audit", "--no-fund", join(root, filename)], project);

	const shim = process.platform === "win32" ? "micme-doctor.cmd" : "micme-doctor";
	await access(join(project, "node_modules", ".bin", shim));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MICME_")));
	const output = runNpm(["exec", "--offline", "--yes=false", "--", "micme-doctor"], project, {
		...env,
		HOME: root,
		NODE_OPTIONS: "",
		PI_CODING_AGENT_DIR: root,
	});
	assert.match(output, /^Micme doctor\r?$/m);
	assert.ok(output.split(/\r?\n/).includes(`- node: ${process.version}`), output);
});
