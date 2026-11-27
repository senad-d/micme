import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { getCatalogVariant, getManagedCatalogVariant, referenceClaim } from "../src/transfer/catalog.ts";
import { listCompute, loadEngine } from "../src/transfer/engine.ts";

const linux = { skip: process.platform !== "linux" };
const freshSignal = () => new AbortController().signal;
const enumerated = [
	{ backend: "vulkan", device: { id: "gpu-a", label: "same model" } },
	{ backend: "vulkan", device: { id: "gpu-b", label: "same model" } },
	{ backend: "cpu", device: null },
];
const choice = { variantId: referenceClaim("moonshine-streaming-tiny").variants.find((row) => row.quant === "Q8_0").id, compute: "cpu", requestedDeviceId: null, language: "en", task: "transcribe", detector: "off", chunking: true };

function peer(mode, pidFile, devices) {
	const { writeFileSync } = process.getBuiltinModule("node:fs");
	let input = Buffer.alloc(0);
	process.stdin.on("data", (chunk) => {
		input = Buffer.concat([input, chunk]);
		if (input.length < 5 || input.length < input.readUInt32BE() + 4) return;
		const op = String.fromCharCode(input[4]);
		input = input.subarray(input.readUInt32BE() + 4);
		if (op === "V") writeFileSync(pidFile, String(process.pid));
		if (op === "V" && mode === "hang") return;
		if (op === "V" && mode === "lost") process.exit(23);
		const reply = { version: 1, ok: true, asrCalls: 0, asrLoads: 0, vadLoads: 0, peakRssBytes: null, data: op === "V" ? { devices } : {} };
		if (op === "V" && mode === "error") Object.assign(reply, { ok: false, error: "Native probe failed." });
		const payload = Buffer.from(JSON.stringify(reply));
		const header = Buffer.alloc(4);
		header.writeUInt32BE(op === "V" && mode === "oversize" ? 256 * 1024 + 1 : payload.length);
		process.stdout.write(header.subarray(0, 2));
		setImmediate(() => process.stdout.write(header.subarray(2), () => {
			if (mode !== "oversize") process.stdout.write(payload, () => { if (op === "Q") process.exit(0); });
		}));
	});
}

async function remove(dir) { await rm(dir, { recursive: true, force: true }); }

async function provision(t, mode = "ok") {
	const dir = await mkdtemp(join(tmpdir(), "micme-native-engine-"));
	t.after(remove.bind(null, dir));
	const recognizerFile = join(dir, "recognizer.cjs");
	const pidFile = join(dir, "pid");
	const source = `#!${process.execPath}\n(${peer.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(pidFile)}, ${JSON.stringify(enumerated)});\n`;
	await writeFile(recognizerFile, source, { mode: 0o700 });
	return { recognizerFile, recognizerSha256: createHash("sha256").update(source).digest("hex"), pidFile };
}

async function peerPid(pidFile) {
	for (let n = 0; n < 100; n++) {
		try {
			return Number(await readFile(pidFile, "utf8"));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await delay(10);
		}
	}
	throw new Error("The fixture never received a probe.");
}

function gone(pid) {
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("native probes preserve distinct same-backend runtime IDs and a null backend-only identity", linux, async (t) => {
	const local = await provision(t);
	assert.deepEqual(await listCompute(local), enumerated);
	gone(await peerPid(local.pidFile));
});

test("a hung native probe is reaped on cancel and an independent next probe works", linux, async (t) => {
	const hung = await provision(t, "hang");
	const controller = new AbortController();
	const rejected = assert.rejects(listCompute(hung, controller.signal), { name: "AbortError" });
	const pid = await peerPid(hung.pidFile);
	controller.abort();
	await rejected;
	gone(pid);
	assert.deepEqual(await listCompute(await provision(t)), enumerated);
});

test("native EOF before the observed response is not a successful empty device list", linux, async (t) => {
	const local = await provision(t, "lost");
	await assert.rejects(listCompute(local), /exited/);
	gone(await peerPid(local.pidFile));
});

test("a native returned error is surfaced and the failed child disappears", linux, async (t) => {
	const local = await provision(t, "error");
	await assert.rejects(listCompute(local), /Native probe failed/);
	gone(await peerPid(local.pidFile));
});

test("a native frame exceeding the bounded reply limit is rejected on its header", linux, async (t) => {
	const local = await provision(t, "oversize");
	await assert.rejects(listCompute(local), /Invalid native recognizer frame length/);
	gone(await peerPid(local.pidFile));
});

test("a mismatching helper digest prevents dispatch", linux, async (t) => {
	const local = await provision(t);
	await assert.rejects(listCompute({ ...local, recognizerSha256: "0".repeat(64) }), /pinned bytes/);
	await assert.rejects(readFile(local.pidFile), { code: "ENOENT" });
});

test("explicitly missing helper pins cannot fall through to an ambient executable", linux, async () => {
	await assert.rejects(listCompute({ recognizerFile: null, recognizerSha256: null }), /file and its SHA-256/);
});

test("loading requires both an exact rights-cleared variant and its matching offline bytes", linux, async (t) => {
	const local = await provision(t);
	const [blob] = getCatalogVariant(choice.variantId).blobs;
	const engineModelFiles = [{ variantId: choice.variantId, blobPath: blob.path, file: local.recognizerFile, sha256: blob.sha256 }];
	await assert.rejects(loadEngine({ ...choice, variantId: "moonshine-streaming-tiny" }, freshSignal(), { ...local, engineModelFiles }), /rights-cleared exact/);
	await assert.rejects(loadEngine(choice, freshSignal(), { ...local, engineModelFiles: [] }), /Provision the exact native model/);
	await assert.rejects(loadEngine(choice, freshSignal(), { ...local, engineModelFiles }), /expected file size/);
});

test("the actual component observations qualify only exact English transcribe cells on their bound CPU rig", async () => {
	const record = JSON.parse(await readFile(new URL("../native/recognizer/linux-x64-component.json", import.meta.url), "utf8"));
	assert.equal(record.components.length, 2);
	for (const { id, blob, traits, english } of record.components) {
		const row = getCatalogVariant(id);
		const measurement = row.measurements.find((cell) => cell.language === "en");
		assert.deepEqual(row.blobs, [blob]);
		assert.equal(measurement.wer, english.errors.wer);
		assert.ok(measurement.rig.endsWith(record.binarySha256));
		const scope = { rig: measurement.rig, actualCompute: traits.actualCompute, device: traits.boundDevice };
		const offer = getManagedCatalogVariant(id, scope, "transcribe", "en");
		assert.deepEqual(offer?.traits, traits);
		assert.deepEqual(offer?.languages, ["en"]);
		assert.equal(getManagedCatalogVariant(id, scope, "transcribe", "fr"), null);
		assert.equal(getManagedCatalogVariant(id, { ...scope, device: null }, "transcribe", "en"), null);
	}
});
