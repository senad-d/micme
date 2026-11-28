import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import references from "./fixtures/audio/references.json" with { type: "json" };
import { sha256, wavDurationMs } from "./live-native/corpus.mjs";

const directory = new URL("fixtures/audio/", import.meta.url);
// Digests cover the prepared PCM, not the original source containers or WAV headers.
const referencePcm = {
	"english-commission.wav": "0e31908590c9157843b01e6486d83e74d9d986c13f00787f7d0d41362a339609",
	"english-continuous.wav": "ff58760aeeeb52e6a61a850e9934207a7a4b4667f1a4e7255ad773efd8978bc7",
	"english-dumas.wav": "bb2d2606b35016a2e4f6ad91a195605d323c7add07390822755831877a25707a",
	"english-jfk.wav": "a29462b8ebd467318000e683b9117ade46230d3255ed2024e7db894abd9b38c9",
	"english-natural-history.wav": "e5f7e00dc5106221158f2e5ea35c8d2b01e70faefe277fd2301d2ecaa18cdc91",
	"english-quiet.wav": "5754225fc7732fed378d66aae369ede06c6b6413f2b4d6b5abc9e049158f930a",
	"english-thank-you.wav": "8f7a7c15c0e40168107cffe0299d4a5d4e17b1214af0cbf20ba61ca59b07817b",
	"french-paris.wav": "9898d5be1720e8d89219293006b6d6c48324b94cc40acdcefe01e18ed866a6f4",
	"rain-noise.wav": "823579e8c8818ee99f87e6fa4d38f4f939305bec6248c619b4af3550aaf022c1",
	"russian-birthday.wav": "454b3137af9992f43d04ba124bc00985ee312ced4ae51951480f18003a8a2516",
};

test("the fixture directory and quality references cover exactly the ten pinned WAVs", async () => {
	const expected = Object.keys(referencePcm).sort();
	assert.deepEqual((await readdir(directory)).sort(), ["README.md", "references.json", ...expected].sort());
	assert.deepEqual(Object.keys(references).sort(), expected);
});

test("every audio fixture is a nonempty canonical WAV accepted by the paced recorder", async () => {
	for (const name of Object.keys(referencePcm)) {
		const wave = await readFile(new URL(name, directory));
		assert.ok(wavDurationMs(wave, name) > 0, name);
	}
});

test("each fixture retains its reference PCM content", async () => {
	for (const [name, digest] of Object.entries(referencePcm)) {
		const wave = await readFile(new URL(name, directory));
		assert.equal(sha256(wave.subarray(44)), digest, name);
	}
});
