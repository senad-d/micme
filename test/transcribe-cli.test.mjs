import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transcribeWavCli } from "../scripts/transcribe.mjs";
import { createLiveRecordingDirectory } from "../src/recording-dir.ts";
import { TRANSCRIBE_CLI_EXIT as exit, TRANSCRIBE_CLI_FLAGS as flags } from "../src/transfer/contracts.ts";
import { sha256, wavHeader } from "./live-native/corpus.mjs";

const model = "installed-exact-model";
const devices = [
	{ backend: "vulkan", device: { id: "gpu:0", label: "Device A" } },
	{ backend: "vulkan", device: { id: "gpu:1", label: "Device B" } },
];
const choice = { variantId: model, compute: "auto", requestedDeviceId: null, language: "en", task: "transcribe", detector: "off", chunking: true };
const service = {
	async listInstalled() { return [choice]; },
	async listCompute() { return devices; },
	async recognizeFile() { assert.fail("unexpected inference"); },
	async unload() {},
};
const pcm = Buffer.from([1, 0, 2, 0]);
const wav = () => Buffer.concat([wavHeader(pcm.length), pcm]);
const fileArgs = (file, device = "auto", id = model) => [flags.model, id, flags.device, device, file];

async function sample(t, bytes) {
	const dir = await mkdtemp(join(tmpdir(), "micme-cli-unit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "sample.wav");
	await writeFile(file, bytes);
	return file;
}

function assertFailure(result, code, detail) {
	assert.equal(result.code, code, result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, detail);
}

test("CLI rejects invalid flags, conflicting modes and nonpositive or partial repeat counts", async () => {
	for (const args of [[], [flags.listModels, flags.listDevices], [flags.listModels, "file.wav"], [flags.listModels, flags.listModels],
		[...fileArgs("file.wav"), flags.repeat, "0"], [...fileArgs("file.wav"), flags.repeat, "2x"],
		[...fileArgs("file.wav"), flags.repeat, "9007199254740992"], [...fileArgs("file.wav"), "extra.wav"], ["--invalid"]]) {
		assertFailure(await transcribeWavCli(args, service), exit.usage, /Usage:/);
	}
});

test("CLI accepts only regular WAV files with a complete valid RIFF layout and mono 16 kHz PCM16 frames", async (t) => {
	const file = await sample(t, wav());
	const edited = (value, offset) => { const bytes = wav(); bytes.writeUInt16LE(value, offset); return bytes; };
	const invalid = [Buffer.from("not a WAV"), edited(2, 22), edited(8_000, 24), edited(8, 34), edited(3, 20),
		edited(4, 32), edited(3, 40), wav().subarray(0, -1), Buffer.concat([wav(), Buffer.from("extra")]),
		Buffer.concat([edited(48, 4), Buffer.from("data\x00\x00\x00\x00")])];
	for (const bytes of invalid) {
		await writeFile(file, bytes);
		assertFailure(await transcribeWavCli(fileArgs(file), service), exit.usage, /16 kHz mono.*PCM WAV/);
	}
	assertFailure(await transcribeWavCli(fileArgs(join(file, "..")), service), exit.usage, /regular file/);
	assertFailure(await transcribeWavCli(fileArgs(join(file, "..", "absent.wav")), service), exit.usage, /regular file/);
});

test("CLI lists installed IDs and keeps same-backend device candidates distinct", async () => {
	assert.deepEqual(JSON.parse((await transcribeWavCli([flags.listModels, flags.json], service)).stdout), { models: [model] });
	assert.deepEqual(JSON.parse((await transcribeWavCli([flags.listDevices, flags.json], service)).stdout), { devices });
	assert.deepEqual((await transcribeWavCli([flags.listDevices], service)).stdout.trimEnd().split("\n"), ["vulkan\tgpu:0\tDevice A", "vulkan\tgpu:1\tDevice B"]);
});

test("CLI text listings keep multiline metadata in one entry without changing JSON IDs", async () => {
	const variantId = "/models/first\nsecond.bin";
	const device = { backend: "vulkan", device: { id: "gpu:0", label: "First\nline\tsecond" } };
	const fixture = { ...service, async listInstalled() { return [{ ...choice, variantId }]; }, async listCompute() { return [device]; } };
	assert.equal((await transcribeWavCli([flags.listModels], fixture)).stdout, `${JSON.stringify(variantId)}\n`);
	assert.equal((await transcribeWavCli([flags.listDevices], fixture)).stdout, `vulkan\tgpu:0\t${JSON.stringify(device.device.label)}\n`);
	assert.deepEqual(JSON.parse((await transcribeWavCli([flags.listModels, flags.json], fixture)).stdout), { models: [variantId] });
	assert.deepEqual(JSON.parse((await transcribeWavCli([flags.listDevices, flags.json], fixture)).stdout), { devices: [device] });
});

test("CLI refuses missing installed model and unlisted device without inference", async (t) => {
	const file = await sample(t, wav());
	assertFailure(await transcribeWavCli(fileArgs(file, "auto", "not-installed"), service), exit.failed, /--list-models/);
	for (const device of ["gpu:9", "metal"]) {
		assertFailure(await transcribeWavCli(fileArgs(file, device), service), exit.failed, /--list-devices/);
	}
});

test("CLI repeats the verified input and exact choice, reports every elapsed time and uses the loaded device label", async (t) => {
	const bytes = Buffer.concat([wav().subarray(0, 12), Buffer.from("JUNK\x01\x00\x00\x00!\x00"), wav().subarray(12), Buffer.from("LIST\x00\x00\x00\x00")]);
	bytes.writeUInt32LE(bytes.length - 8, 4);
	const file = await sample(t, bytes);
	let calls = 0;
	const fixture = {
		...service,
		async recognizeFile(audio, selected, job, _progress, signal) {
			assert.deepEqual(selected, { ...choice, compute: "vulkan", requestedDeviceId: "gpu:1" });
			assert.equal(job, "cli");
			assert.equal(audio.bytes, bytes.length);
			assert.equal(audio.sha256, sha256(bytes));
			if (++calls === 1) await writeFile(file, "the caller changed the original after snapshot");
			const target = await createLiveRecordingDirectory(process.cwd(), false, "micme-cli-unit-copy-");
			try { assert.deepEqual(await readFile(await audio.copyTo(target, signal)), bytes); }
			finally {
				try { await target.remove(); }
				finally { target.close(); }
			}
			return { actualCompute: "vulkan", boundDevice: { id: "gpu:1", label: "Loaded Device B" }, language: "en", local: `Réponse ${calls}` };
		},
	};
	const result = await transcribeWavCli([...fileArgs(file, "gpu:1"), flags.repeat, "2", flags.json], fixture);
	assert.equal(result.code, exit.success, result.stderr);
	assert.equal(result.stderr, "");
	const { runs, ...output } = JSON.parse(result.stdout);
	assert.deepEqual(output, { model, requestedDevice: "gpu:1", device: "vulkan", boundDevice: { id: "gpu:1", label: "Loaded Device B" }, language: "en", text: "Réponse 2", audioSamples: 2 });
	assert.deepEqual(runs.map(({ index }) => index), [1, 2]);
	assert.ok(runs.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0));
	assert.equal(await readFile(file, "utf8"), "the caller changed the original after snapshot");
});

test("CLI does not turn an enumerated candidate into a binding when recognition reports none", async (t) => {
	const file = await sample(t, wav());
	const fixture = { ...service, async recognizeFile() { return { actualCompute: "unknown", boundDevice: null, language: null, local: "Café" }; } };
	const result = await transcribeWavCli(fileArgs(file), fixture);
	assert.equal(result.code, exit.success, result.stderr);
	assert.equal(result.stdout, "Café\n");
	assert.match(result.stderr, /Requested: auto; observed: unknown\nRun 1: [\d.]+ ms/);
	assertFailure(await transcribeWavCli(fileArgs(file, "gpu:1"), fixture), exit.failed, /did not confirm/);
});

test("CLI keeps an inference failure off stdout and does not echo backend output", async (t) => {
	const file = await sample(t, wav());
	const fixture = { ...service, async recognizeFile() { throw new Error("private backend output"); } };
	const result = await transcribeWavCli(fileArgs(file), fixture);
	assertFailure(result, exit.failed, /micme-doctor/);
	assert.doesNotMatch(result.stderr, /private backend output/);
});
