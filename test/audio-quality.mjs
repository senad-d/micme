import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import references from "./fixtures/audio/references.json" with { type: "json" };
import { hashFile, wavDurationMs } from "./live-native/corpus.mjs";
import { wordErrors } from "./live-native/scoring.mjs";

const fixtures = new URL("fixtures/audio/", import.meta.url);

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

function summarize(cases) {
	const speech = { cases: 0, words: 0, substitutions: 0, deletions: 0, insertions: 0 };
	const nonSpeech = { cases: 0, withOutput: 0 };
	let failedCases = 0;
	let audioMs = 0;
	let elapsedMs = 0;
	for (const entry of cases) {
		if (Object.hasOwn(entry, "error")) {
			failedCases++;
			continue;
		}
		audioMs += entry.audioMs;
		elapsedMs += entry.elapsedMs;
		if (entry.reference === null) {
			nonSpeech.cases++;
			nonSpeech.withOutput += Number(entry.quality.emittedText);
			continue;
		}
		speech.cases++;
		for (const key of ["words", "substitutions", "deletions", "insertions"]) speech[key] += entry.quality[key];
	}
	const errors = speech.substitutions + speech.deletions + speech.insertions;
	return {
		completedCases: cases.length - failedCases, failedCases, audioMs, elapsedMs,
		realTimeFactor: audioMs ? elapsedMs / audioMs : null,
		speech: { ...speech, wer: speech.words ? errors / speech.words : null },
		nonSpeech,
	};
}

export async function measureCases(entries, transcribe, now = () => performance.now()) {
	// processes.ts loads Micme config transitively; the CLI must isolate settings first.
	const { normalizeTranscript } = await import("../src/processes.ts");
	const cases = [];
	for (const entry of entries) {
		const start = now();
		let raw;
		try {
			raw = await transcribe(entry);
		} catch (error) {
			cases.push({ ...entry, error: describe(error) });
			continue;
		}
		const elapsedMs = now() - start;
		const transcript = normalizeTranscript(raw);
		const score = wordErrors(entry.reference ?? "", transcript);
		const quality = entry.reference === null
			? { wer: null, emittedText: transcript.length > 0, outputTokens: score.insertions }
			: score;
		cases.push({ ...entry, transcript, elapsedMs, realTimeFactor: elapsedMs / entry.audioMs, quality });
	}
	return { cases, summary: summarize(cases) };
}

async function run([binaryArg, modelArg, ...extra]) {
	if (!binaryArg || !modelArg || extra.length) {
		console.error("Usage: npm run --silent test:audio-quality -- /path/to/whisper-cli /path/to/multilingual-ggml.bin");
		return 2;
	}
	const binary = resolve(binaryArg);
	const model = resolve(modelArg);
	await access(binary, constants.X_OK);
	const identity = { binary: await hashFile(binary), model: await hashFile(model) };
	const entries = await Promise.all(Object.entries(references).map(async ([file, reference]) => ({
		file, ...reference, audioMs: wavDurationMs(await readFile(new URL(file, fixtures)), file),
	})));

	const work = await mkdtemp(join(tmpdir(), "micme-audio-quality-"));
	try {
		// This is a dedicated process; do not read the user's Micme settings or download any models.
		for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith("MICME_")) delete process.env[key];
		process.env.PI_CODING_AGENT_DIR = work;
		const { transcribeWithWhisperCpp } = await import("../src/transcription.ts");
		await Promise.all(entries.map(({ file }) => mkdir(join(work, file))));
		const measurement = await measureCases(entries, ({ file, language }) => {
			process.env.MICME_LANGUAGE = language;
			return transcribeWithWhisperCpp(binary, model, fileURLToPath(new URL(file, fixtures)), join(work, file), undefined, { allowDownload: false });
		});
		const host = { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, availableCpus: availableParallelism(), node: process.version };
		console.log(JSON.stringify({ backend: "whisper.cpp", mode: "clip", ...identity, host, ...measurement }, null, 2));
		return measurement.summary.failedCases ? 1 : 0;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await run(process.argv.slice(2));
	} catch (error) {
		console.error(`Micme audio quality: ${describe(error)}`);
		process.exitCode = 1;
	}
}
