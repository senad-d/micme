// Public fixtures only. The new controls use supplied human recordings, never ASR
// output (nor generated audio) as ground truth. No audio is fetched here.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { prepareCorpus, RATE, sha256, wavHeader } from "./corpus.mjs";
import { validateEvidencePath } from "./transfer-schema.mjs";

export const fixtureFiles = Object.freeze({
	jfk: "jfk.wav", continuous: "continuous.wav", overload: "overload.wav", short: "short.wav",
	quiet: "quiet.wav", pause: "pause.wav", repeat: "repeat.wav", silence: "silence.wav", noise: "noise.wav",
	immediate: "immediate.wav", french: "french.wav", identifiers: "identifiers.wav", nonlatin: "nonlatin.wav", translation: "translation.wav",
});

// Original scripts and independently written English rendering; CC0-1.0.
// The supplied WAV (and its attribution/permission) is a separate artifact.
export const supplementalReferences = Object.freeze({
	identifiers: Object.freeze({ language: "en", task: "transcribe", spokenText: "Send ticket AB-204 to desk 73 at 09:15. The total is 1,408 dollars." }),
	nonlatin: Object.freeze({ language: "ja", task: "transcribe", spokenText: "東京駅で八時に会いましょう。 the meeting is at eight." }),
	translation: Object.freeze({ language: "fr", task: "translate-en", spokenText: "Le train pour Lyon part à huit heures et demie. Le billet coûte vingt euros.",
		reference: "The train to Lyon leaves at eight thirty. The ticket costs twenty euros." }),
});

export function pcmFromWav(wav) {
	if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) !== wav.length - 8) {
		throw new Error("Expected a complete RIFF/WAVE recording");
	}
	let format = false;
	let data;
	let at = 12;
	while (at + 8 <= wav.length) {
		const kind = wav.toString("ascii", at, at + 4);
		const length = wav.readUInt32LE(at + 4);
		const start = at + 8;
		at = start + length + (length % 2);
		if (at > wav.length) throw new Error("Truncated WAV chunk");
		if (kind === "fmt ") {
			if (format || length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 ||
				wav.readUInt32LE(start + 4) !== RATE || wav.readUInt32LE(start + 8) !== RATE * 2 || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) {
				throw new Error("Expected mono 16 kHz PCM16 WAV");
			}
			format = true;
		} else if (kind === "data") {
			if (!format || data || length === 0 || length % 2) throw new Error("Expected one complete, aligned PCM data chunk");
			data = wav.subarray(start, start + length);
		}
	}
	if (!data || at !== wav.length) throw new Error("Missing PCM or incomplete WAV layout");
	return data;
}

export async function readFixture(assetsDir, trial) {
	const file = fixtureFiles[trial.fixture];
	if (!Object.hasOwn(fixtureFiles, trial.fixture) || !trial.pcmSha256) throw new Error("Fixture or frozen PCM digest not provisioned");
	const path = join(assetsDir, file);
	const pcm = pcmFromWav(await readFile(path));
	if (sha256(pcm) !== trial.pcmSha256) throw new Error("Prepared fixture does not match the frozen PCM digest");
	return { path, pcm };
}

function alignment(entry, script, audioMs, name) {
	const { onsetMs, endMs, alignedWords } = entry;
	if (!Number.isFinite(onsetMs) || onsetMs < 0 || !Number.isFinite(endMs) || endMs <= onsetMs || endMs > audioMs ||
		!Array.isArray(alignedWords) || !alignedWords.length || alignedWords.at(-1)?.endMs !== endMs) throw new Error(`${name}: missing human word alignment`);
	let prev = onsetMs;
	for (const span of alignedWords) {
		if (!span || typeof span.word !== "string" || !span.word.trim() || !Number.isFinite(span.endMs) || span.endMs <= prev || span.endMs > endMs) {
			throw new Error(`${name}: expected ordered human time marks within the WAV`);
		}
		prev = span.endMs;
	}
	const compact = (text) => text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
	if (compact(alignedWords.map(({ word }) => word).join("")) !== compact(script.spokenText)) throw new Error(`${name}: alignment does not transcribe the frozen script`);
	return { onsetMs, endMs, words: alignedWords.map(({ word, endMs }) => ({ word, endMs })) };
}

async function prepareSupplement(entry, sourceRoot, name, script) {
	if (!entry || typeof entry !== "object" || !["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "Public-Domain"].includes(entry.license) ||
		typeof entry.attribution !== "string" || !entry.attribution.trim() || typeof entry.permission !== "string" || !entry.permission.trim()) {
		throw new Error(`${name}: supply public attribution, license and permission evidence for the human recording`);
	}
	validateEvidencePath(entry.file, `${name}.file`);
	const path = await realpath(join(sourceRoot, entry.file));
	validateEvidencePath(relative(sourceRoot, path), `${name}.file`);
	const wav = await readFile(path);
	if (sha256(wav) !== entry.sourceSha256) throw new Error(`${name}: human source recording SHA-256 mismatch`);
	const pcm = pcmFromWav(wav);
	const times = alignment(entry, script, pcm.length / 2 / RATE * 1_000, name);
	if (name === "translation" && (typeof entry.meaningReview !== "string" || !entry.meaningReview.trim())) throw new Error("translation: supply the independent English meaning review");
	return { pcm, metadata: { ...script, ...times, reference: script.reference ?? script.spokenText, samples: pcm.length / 2,
		hash: sha256(pcm), sourceSha256: entry.sourceSha256, attribution: entry.attribution, license: entry.license,
		permission: entry.permission, meaningReview: entry.meaningReview ?? null } };
}

// PUBLIC_SOURCES_JSON has exactly the three supplemental fixture keys; each
// points to a WAV below its directory and includes sourceSha256, license,
// attribution, permission, onsetMs, endMs and alignedWords. Translation also
// includes meaningReview. If not supplied these controls are explicitly absent.
export async function prepareTransferFixtures(assets, destination, sourcesPath = null) {
	const sourceAssets = await realpath(assets);
	const supplemental = new Map();
	if (sourcesPath !== null) {
		const sources = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(sourcesPath)));
		const sourceRoot = await realpath(dirname(resolve(sourcesPath)));
		if (!sources || Object.keys(sources).length !== Object.keys(supplementalReferences).length) throw new Error("Expected identifiers, nonlatin and translation human source entries");
		for (const [name, script] of Object.entries(supplementalReferences)) {
			supplemental.set(name, await prepareSupplement(sources[name], sourceRoot, name, script));
		}
	}
	await mkdir(destination, { recursive: true });
	if (sourceAssets === await realpath(destination)) throw new Error("Prepare into a separate WAV directory, not the pinned source directory");
	const standard = await prepareCorpus(sourceAssets, destination);
	const fixtures = {};
	for (const [name, entry] of Object.entries(standard)) fixtures[name] = { ...entry, path: fixtureFiles[name] };
	for (const [name, script] of Object.entries(supplementalReferences)) {
		const source = supplemental.get(name);
		if (!source) {
			fixtures[name] = { ...script, reference: script.reference ?? script.spokenText, path: null, hash: null, samples: null,
				gap: "Supply pinned, rights-cleared, human-recorded and aligned public audio for this script." };
			continue;
		}
		const file = fixtureFiles[name];
		await writeFile(join(destination, file), Buffer.concat([wavHeader(source.pcm.length), source.pcm]));
		fixtures[name] = { path: file, ...source.metadata };
	}
	await writeFile(join(destination, "transfer-fixtures.json"), `${JSON.stringify({ version: 1, fixtures }, null, 2)}\n`);
	return fixtures;
}
