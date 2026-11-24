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

test("saving a missing model rechecks config and rejects malformed JSON before fetching", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "micme-settings-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousAutoDownload = process.env.MICME_AUTO_DOWNLOAD_MODEL;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousAutoDownload === undefined) delete process.env.MICME_AUTO_DOWNLOAD_MODEL;
		else process.env.MICME_AUTO_DOWNLOAD_MODEL = previousAutoDownload;
		reloadMicmeConfig();
		await rm(agentDir, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.MICME_AUTO_DOWNLOAD_MODEL = "1";
	const configPath = join(agentDir, "micme.json");
	await writeFile(configPath, "{}");
	reloadMicmeConfig();
	const malformed = "{ invalid json";
	await writeFile(configPath, malformed);
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response("mock model bytes"));

	const save = saveConfigurationValue(createCtx(), "MICME_WHISPER_CPP_MODEL", join(agentDir, "models", "ggml-tiny.bin"));
	await assert.rejects(save, (error) => error.message.includes(configPath) && /invalid.*JSON|not valid JSON/.test(error.message));
	assert.equal(fetch.mock.callCount(), 0);
	assert.equal(await readFile(configPath, "utf8"), malformed);
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
