import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const SUPPORTED_PI_VERSION = "0.80.7";

async function readInstalledManifest(packageName) {
	const path = join(process.cwd(), "node_modules", ...packageName.split("/"), "package.json");
	return JSON.parse(await readFile(path, "utf8"));
}

async function withEnv(values, fn) {
	const previous = new Map();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("Pi's jiti loader registers the default Micme extension", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "micme-pi-contract-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));

	const [codingAgentManifest, tuiManifest] = await Promise.all([
		readInstalledManifest("@earendil-works/pi-coding-agent"),
		readInstalledManifest("@earendil-works/pi-tui"),
	]);
	assert.equal(codingAgentManifest.name, "@earendil-works/pi-coding-agent");
	assert.equal(codingAgentManifest.version, SUPPORTED_PI_VERSION);
	assert.equal(tuiManifest.name, "@earendil-works/pi-tui");
	assert.equal(tuiManifest.version, SUPPORTED_PI_VERSION);

	await withEnv(
		{
			PI_CODING_AGENT_DIR: agentDir,
			MICME_SHORTCUT: "alt+m",
			MICME_PRINTABLE_SHORTCUTS: "",
		},
		async () => {
			const entrypoint = join(process.cwd(), "src", "extension.ts");
			const result = await discoverAndLoadExtensions([entrypoint], agentDir, agentDir);

			assert.deepEqual(result.errors, []);
			assert.equal(result.extensions.length, 1);
			const extension = result.extensions[0];
			assert.ok(extension);
			assert.equal(extension.commands.has("micme"), true);
			assert.equal(extension.shortcuts.has("alt+m"), true);
			assert.equal(extension.handlers.has("session_start"), true);
			assert.equal(extension.handlers.has("session_shutdown"), true);
		},
	);
});
