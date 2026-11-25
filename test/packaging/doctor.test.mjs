import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
test("the npm-installed micme-doctor runs without type stripping and probes Worker v1 without models", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-install-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	await mkdir(project);

	const [{ filename }] = JSON.parse(runNpm(["pack", "--json", "--pack-destination", root], packageRoot));
	runNpm(["install", "--no-audit", "--no-fund", join(root, filename)], project);

	const shim = process.platform === "win32" ? "micme-doctor.cmd" : "micme-doctor";
	await access(join(project, "node_modules", ".bin", shim));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MICME_")));
	const worker = join(root, "local worker");
	const models = join(root, "models");
	const stream = process.platform !== "win32"; // The protocol fixture is a POSIX executable; the banner check still runs on Windows.
	if (stream) {
		await writeFile(worker, "#!/bin/sh\n[ \"$#\" -eq 1 ] && [ \"$1\" = --protocol-version ] || exit 99\nprintf '1\\n'\n", { mode: 0o755 });
		await writeFile(join(root, "micme.json"), JSON.stringify({
			MICME_TRANSCRIPTION_MODE: "stream",
			MICME_LIVE_BIN: worker,
			MICME_MODEL_DIR: models,
			MICME_AUTO_DOWNLOAD_MODEL: false,
		}));
	}
	const output = runNpm(["exec", "--offline", "--yes=false", "--", "micme-doctor"], project, {
		...env,
		HOME: root,
		NODE_OPTIONS: "--no-experimental-strip-types",
		PI_CODING_AGENT_DIR: root,
	});
	assert.match(output, /^Micme doctor\r?$/m);
	const lines = output.split(/\r?\n/);
	assert.ok(lines.includes(`- node: ${process.version}`), output);
	if (!stream) return;

	for (const line of [
		"- transcription mode: stream",
		`- live worker binary: ${worker}`,
		`! resolved whisper.cpp model is missing: ${join(models, "ggml-small.en.bin")}`,
		`! live VAD weights not present as a regular file: ${join(models, "vad", "ggml-silero-v5.1.2.bin")}`,
		"✓ live worker protocol: Worker v1 available; model readiness and capture not tested",
	]) assert.ok(lines.includes(line), output);
	await assert.rejects(access(models), { code: "ENOENT" });
});
