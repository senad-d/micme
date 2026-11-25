import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const RATE = 16_000;
// Only the continuous final-tail check accepts equivalent renderings of the frozen year.
export const CONTINUOUS_KEYWORDS = ["but now it eighteen sixty three", "but now it 1863"];
const bytesPerMs = RATE * 2 / 1_000;
const hashes = {
	"jfk.wav": "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
	"rain.wav": "d732acd2e0c7c40405968010f49f250740c86998fc416eff2ed5330fc8c89dea",
	"thanks.ogg": "175d5f748e729e95da0eea4791be9e719c712a14bf931be6257fd20409021296",
	"paris.ogg": "7a163e1c1fdaf235af704429f9b743e62b030a1ea36ca4bc284948b0a5319077",
	"174-84280-0011.flac": "9e1f71ac4690fd2ecc389169b7c8bac446d2dea6e269d7716c3855c33246712c",
	"6241-61943-0003.flac": "8ea348c42e60130347063e2e14daf8779ba8dababceaace7b2bde15a6cb92000",
	"5338-24640-0003.flac": "74dfa4988d7df69b592e14af6f8829ab95e31eb93112034eb225469adde9be0b",
	"3576-138058-0019.flac": "9d754e1dbeccaa0f1e40e2aadc0b75c806b685d60fbdf4ca9e900f40b5f1c730",
	"2412-153947-0008.flac": "2600428c6b990417ad58cdb8f72bda81a8e783b891d0f4338105557f2ff8289e",
};
const jfk = "And so my fellow Americans ask not what your country can do for you ask what you can do for your country.";
const silence = (ms) => Buffer.alloc(ms * bytesPerMs);
const slice = (pcm, from, to) => pcm.subarray(from * bytesPerMs, to * bytesPerMs);
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function wavHeader(pcmBytes) {
	const head = Buffer.from("524946460000000057415645666d74201000000001000100803e0000007d0000020010006461746100000000", "hex");
	head.writeUInt32LE(pcmBytes + 36, 4);
	head.writeUInt32LE(pcmBytes, 40);
	return head;
}

async function loadSource(assets, name) {
	const path = join(assets, name);
	assert.equal(sha256(await readFile(path)), hashes[name], `Unexpected source bytes: ${path}`);
	return execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-ar", String(RATE), "-ac", "1", "-f", "s16le", "pipe:1"]);
}

function quietPcm(pcm) {
	const attenuated = Buffer.from(pcm);
	for (let i = 0; i < pcm.length; i += 2) attenuated.writeInt16LE(Math.round(pcm.readInt16LE(i) * 10 ** (-18 / 20)), i);
	return attenuated;
}

async function alignedCorpus(assets) {
	const alignment = JSON.parse(await readFile(new URL("alignment.json", import.meta.url), "utf8"));
	const edited = [];
	const words = [];
	let offset = 250;
	for (const { id, transcript, words: times } of alignment) {
		assert.equal(times.map(([word]) => word).join(" "), transcript, `Alignment mismatch: ${id}`);
		const pcm = await loadSource(assets, `${id}.flac`);
		const start = times[0][1] - 20;
		const end = times.at(-1)[2] + 20;
		assert.ok(pcm.length >= end * bytesPerMs);
		edited.push(slice(pcm, start, end));
		for (const [word, , endMs] of times) words.push({ word, endMs: offset + endMs - start });
		offset += end - start;
	}
	assert.ok(words.at(-1).endMs - 270 >= 30_000);
	return { words, onsetMs: 270, endMs: words.at(-1).endMs, pcm: Buffer.concat([silence(250), ...edited, silence(1_000)]) };
}

export async function prepareCorpus(assets, work) {
	const continuous = await alignedCorpus(assets);
	const first = await loadSource(assets, "174-84280-0011.flac");
	const rain = await loadSource(assets, "rain.wav");
	const cases = {
		continuous: { ...continuous, reference: continuous.words.map(({ word }) => word).join(" "), keywords: CONTINUOUS_KEYWORDS },
		jfk: { pcm: await loadSource(assets, "jfk.wav"), reference: jfk, keywords: "fellow americans ask not ask what you can do for your country" },
		silence: { pcm: silence(10_000), reference: "", negative: true },
		noise: { pcm: Buffer.concat([rain, rain]), reference: "", negative: true },
		short: { pcm: Buffer.concat([silence(150), await loadSource(assets, "thanks.ogg"), silence(850)]), reference: "thank you", keywords: "thank you" },
		quiet: { pcm: Buffer.concat([silence(250), quietPcm(slice(first, 360, 3_110)), silence(850)]), reference: "but now it doesn't seem to matter very much", keywords: "but now very much" },
		pause: { pcm: Buffer.concat([silence(250), slice(first, 360, 1_480), silence(1_050), slice(first, 1_480, 3_110), silence(850)]), reference: "but now it doesn't seem to matter very much", keywords: "but now doesn't seem very much" },
		repeat: { pcm: Buffer.concat([silence(250), slice(first, 360, 1_000), slice(first, 360, 3_110), silence(850)]), reference: "but now but now it doesn't seem to matter very much", keywords: "but now but now very much" },
		immediate: { pcm: silence(20), reference: "", negative: true },
		french: { pcm: Buffer.concat([silence(250), await loadSource(assets, "paris.ogg"), silence(900)]), reference: "Paris", keywords: "Paris", language: "fr" },
	};
	cases.overload = { ...cases.jfk, slow: true };
	for (const [name, entry] of Object.entries(cases)) {
		const { pcm } = entry;
		entry.path = join(work, `${name}.wav`);
		entry.samples = pcm.length / 2;
		entry.hash = sha256(pcm);
		await writeFile(entry.path, Buffer.concat([wavHeader(pcm.length), pcm]));
		delete entry.pcm;
	}
	return cases;
}
