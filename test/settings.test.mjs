import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { reloadMicmeConfig } = await import("../src/config.ts");
const { displayConfigurationValue, saveConfigurationValue } = await import("../src/settings.ts");

function createCtx() {
	return {
		ui: {
			setStatus() {},
			notify() {},
		},
	};
}

test("configuration display values strip terminal control sequences", () => {
	assert.equal(displayConfigurationValue("MICME_LANGUAGE", "en\x1b]52;c;clipboard\x07\x1b[31m-US\x1b[0m"), "en -US");
	assert.equal(displayConfigurationValue("MICME_WHISPER_CPP_MODEL", "/tmp/\x1b[31mggml-small.en.bin\x1b[0m"), "ggml-small.en.bin");
});

test("clearing the whisper.cpp model removes the explicit override from micme.json", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "micme-settings-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		reloadMicmeConfig();
		await rm(agentDir, { recursive: true, force: true });
	});

	process.env.PI_CODING_AGENT_DIR = agentDir;
	const configPath = join(agentDir, "micme.json");
	await writeFile(configPath, JSON.stringify({ MICME_WHISPER_CPP_MODEL: "/tmp/ggml-small.en.bin", MICME_LANGUAGE: "en" }, null, 2));
	reloadMicmeConfig();

	await saveConfigurationValue(createCtx(), "MICME_WHISPER_CPP_MODEL", "");

	const saved = JSON.parse(await readFile(configPath, "utf8"));
	assert.equal(Object.hasOwn(saved, "MICME_WHISPER_CPP_MODEL"), false);
	assert.equal(saved.MICME_LANGUAGE, "en");
});
