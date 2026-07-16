import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const configModuleUrl = new URL("../src/config.ts", import.meta.url).href;
const childWriter = `
const [moduleUrl, key, value] = process.argv.slice(1);
const { writeMicmeConfigValue } = await import(moduleUrl);
await writeMicmeConfigValue(key, value);
`;
const { reloadMicmeConfig, writeMicmeConfigValue, writeMicmeConfigValues } = await import("../src/config.ts");

async function createConfigRoot(t, initial) {
	const root = await mkdtemp(join(tmpdir(), "micme-config-write-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	await writeFile(join(root, "micme.json"), `${JSON.stringify(initial, null, 2)}\n`);
	reloadMicmeConfig();
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		reloadMicmeConfig();
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

async function readConfig(root) {
	return JSON.parse(await readFile(join(root, "micme.json"), "utf8"));
}

async function listTemporaryFiles(root) {
	return (await readdir(root)).filter((name) => name.startsWith(".micme.") && name.endsWith(".tmp"));
}

async function runChildWriter(root, key, value) {
	await execFileAsync(process.execPath, ["--input-type=module", "--eval", childWriter, configModuleUrl, key, value], {
		env: { ...process.env, PI_CODING_AGENT_DIR: root },
	});
}

test("concurrent promise writes preserve disjoint keys and metadata repeatedly", async (t) => {
	const initial = { $schema: "local-schema.json", owner: "keep-me", MICME_EXISTING: "existing" };
	const root = await createConfigRoot(t, initial);

	for (let iteration = 0; iteration < 20; iteration += 1) {
		await writeFile(join(root, "micme.json"), `${JSON.stringify(initial, null, 2)}\n`);
		await Promise.all([
			writeMicmeConfigValue("MICME_REVIEW_A", `a-${iteration}`),
			writeMicmeConfigValue("MICME_REVIEW_B", `b-${iteration}`),
		]);
		const saved = await readConfig(root);
		assert.deepEqual(saved, { ...initial, MICME_REVIEW_A: `a-${iteration}`, MICME_REVIEW_B: `b-${iteration}` });
	}
});

test("same-process conflicting writes commit in call order with last successful value winning", async (t) => {
	const root = await createConfigRoot(t, { $schema: "local-schema.json", owner: "keep-me" });

	await Promise.all([writeMicmeConfigValue("MICME_LANGUAGE", "first"), writeMicmeConfigValue("MICME_LANGUAGE", "second")]);

	assert.deepEqual(await readConfig(root), { $schema: "local-schema.json", owner: "keep-me", MICME_LANGUAGE: "second" });
});

test("separate processes preserve every disjoint update and existing metadata", async (t) => {
	const initial = { $schema: "local-schema.json", owner: "keep-me", MICME_EXISTING: "existing" };
	const root = await createConfigRoot(t, initial);
	const entries = Array.from({ length: 6 }, (_unused, index) => [`MICME_CHILD_${index}`, `child-${index}`]);

	await Promise.all(entries.map(([key, value]) => runChildWriter(root, key, value)));

	assert.deepEqual(await readConfig(root), { ...initial, ...Object.fromEntries(entries) });
});

test("successful atomic replacement keeps the config private", async (t) => {
	const root = await createConfigRoot(t, { owner: "keep-me" });
	const configPath = join(root, "micme.json");

	await writeMicmeConfigValue("MICME_LANGUAGE", "en");

	assert.equal((await stat(configPath)).mode & 0o777, 0o600);
	assert.deepEqual(await readConfig(root), { owner: "keep-me", MICME_LANGUAGE: "en" });
	assert.deepEqual(await listTemporaryFiles(root), []);
});

test("lock timeout leaves another writer's lock and the last valid config untouched", async (t) => {
	const initial = { owner: "keep-me", MICME_LANGUAGE: "en" };
	const root = await createConfigRoot(t, initial);
	const lockPath = join(root, "micme.json.lock");
	await mkdir(lockPath);
	await writeFile(join(lockPath, "owner.json"), '{"pid":999999,"token":"another-writer"}\n');

	await assert.rejects(
		writeMicmeConfigValues({ MICME_LANGUAGE: "de" }, { lockTimeoutMs: 40, lockRetryMs: 5 }),
		/Timed out waiting 40 ms for Micme config lock/,
	);

	assert.deepEqual(await readConfig(root), initial);
	assert.equal((await stat(lockPath)).isDirectory(), true);
	assert.deepEqual(await listTemporaryFiles(root), []);
});

test("cancelling a queued lock wait creates no temporary artifacts", async (t) => {
	const initial = { owner: "keep-me", MICME_LANGUAGE: "en" };
	const root = await createConfigRoot(t, initial);
	const lockPath = join(root, "micme.json.lock");
	await mkdir(lockPath);
	await writeFile(join(lockPath, "owner.json"), '{"pid":999999,"token":"another-writer"}\n');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20);

	try {
		await assert.rejects(writeMicmeConfigValues({ MICME_LANGUAGE: "de" }, { signal: controller.signal, lockTimeoutMs: 1_000, lockRetryMs: 5 }), {
			name: "AbortError",
		});
	} finally {
		clearTimeout(timer);
	}

	assert.deepEqual(await readConfig(root), initial);
	assert.equal((await stat(lockPath)).isDirectory(), true);
	assert.deepEqual(await listTemporaryFiles(root), []);
});

test("write failures leave the last valid config readable and no caller artifacts", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX directory permissions are required for this failure fixture");
		return;
	}
	const initial = { owner: "keep-me", MICME_LANGUAGE: "en" };
	const root = await createConfigRoot(t, initial);
	await chmod(root, 0o500);

	try {
		await assert.rejects(writeMicmeConfigValue("MICME_LANGUAGE", "de"), /EACCES|permission denied/i);
	} finally {
		await chmod(root, 0o700);
	}

	assert.deepEqual(await readConfig(root), initial);
	assert.deepEqual(await listTemporaryFiles(root), []);
});
