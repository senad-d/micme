import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { reloadMicmeConfig } = await import("../src/config.ts");
const { pcm16BufferLevel, readPcm16WaveLevel } = await import("../src/audio-level.ts");

async function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	reloadMicmeConfig();
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		reloadMicmeConfig();
	}
}

test("PCM level helpers handle silence, samples, files, and read failures", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-audio-level-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const wavePath = join(root, "clip.wav");
	const samples = Buffer.alloc(8);
	samples.writeInt16LE(32767, 0);
	samples.writeInt16LE(-32768, 2);
	samples.writeInt16LE(0, 4);
	samples.writeInt16LE(8192, 6);
	const wave = Buffer.concat([Buffer.alloc(44), samples]);

	await writeFile(wavePath, wave);
	await withEnv({ MICME_METER_FLOOR_DB: "60", MICME_METER_PEAK_FLOOR_DB: "50", MICME_METER_RANGE_DB: "40", MICME_METER_GAIN: "0.5" }, async () => {
		assert.equal(pcm16BufferLevel(Buffer.alloc(0)), 0);
		assert.ok(pcm16BufferLevel(samples) > 0);
		assert.ok(readPcm16WaveLevel(wavePath) > 0);
		assert.equal(readPcm16WaveLevel(join(root, "missing.wav")), 0);
	});

	await writeFile(join(root, "too-small.wav"), Buffer.alloc(44));
	assert.equal(readPcm16WaveLevel(join(root, "too-small.wav")), 0);
});
