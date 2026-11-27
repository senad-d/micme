// Functional receipts for the public P7 inputs. This is not a Pi journey or a timing run.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MediaImportService, getImportError, importFiles } from "../../src/transfer/import.ts";
import { setForeground } from "../../src/transfer/jobs.ts";
import { listInstalled, observeRecognition, recognizeFile } from "../../src/transfer/recognition.ts";
import { deleteRow, page, retry, verifiedAudio } from "../../src/transfer/library.ts";
import { withVerifiedPcm } from "../../src/transfer/recognition-audio.ts";
import { applyPrune, previewPrune } from "../../src/transfer/retention.ts";
import { wavHeader } from "./corpus.mjs";

const jfkHash = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";
const modelHash = "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f";
const signal = AbortSignal.timeout(90_000);
const terminal = (row) => ["ready", "canceled", "asr-failed", "save-failed", "interrupted"].includes(row.state);
const stableError = (error) => error?.replaceAll(/0x[\da-f]{8,}/gi, "<address>") ?? null;

async function sha(path) {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path)) hash.update(bytes);
	return hash.digest("hex");
}

function encode(path, ...args) {
	const result = spawnSync("ffmpeg", ["-nostdin", "-v", "error", ...args, path], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

async function until(id, predicate) {
	while (true) {
		signal.throwIfAborted();
		const row = (await page(null)).find((candidate) => candidate.id === id);
		if (row && predicate(row)) return row;
		await delay(15, undefined, { signal });
	}
}

async function inspect(row, expectedMedia, finals) {
	const receipt = await verifiedAudio(row.id, signal);
	assert.ok(receipt);
	assert.equal(row.state, "ready");
	assert.match(row.raw, /fellow Americans/i);
	assert.equal(row.doneSamples, row.totalSamples);
	const pcm = await withVerifiedPcm(receipt, signal, async (input) => ({ samples: input.total, sha256: await input.digest(signal) }));
	assert.ok(finals.some(({ inputSamples, inputPcmSha256 }) => inputSamples === pcm.samples && inputPcmSha256 === pcm.sha256));
	const sourceSha256After = await sha(expectedMedia.path);
	assert.equal(sourceSha256After, expectedMedia.sha256);
	return { filename: row.filename, state: row.state, raw: row.raw, local: row.local, sourceSha256Before: expectedMedia.sha256,
		sourceSha256After, verifiedWav: row.wav, normalizedPcm: pcm };
}

async function collect(jfk, binary, model, root) {
	assert.equal(await sha(jfk), jfkHash);
	assert.equal(await sha(model), modelHash);
	const modelFile = join(root, "ggml-tiny.en.bin");
	await copyFile(model, modelFile);
	for (const key of Object.keys(process.env)) if (key.startsWith("MICME_")) delete process.env[key];
	const hook = join(root, "fixture-output-hook");
	const hookCount = join(root, "hook-invoked");
	await writeFile(hook, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(hookCount)}, 'invoked');\n`, { mode: 0o700 });
	Object.assign(process.env, { HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: root, MICME_HISTORY: "1", MICME_AUTO_SUBMIT: "1",
		MICME_WHISPER_CPP_BIN: binary, MICME_WHISPER_CPP_MODEL: modelFile, MICME_OUTPUT_HOOK: hook });
	process.chdir(root);
	const installed = (await listInstalled()).find((row) => row.variantId === modelFile);
	assert.ok(installed, "preverified explicit model must be discoverable");
	const choice = { ...installed, compute: "cpu", language: "en", chunking: false };
	const opus = join(root, "JFK speech.opus");
	const movie = join(root, "JFK two-track video.mp4");
	const noAudio = join(root, "no-audio.mp4");
	const malformed = join(root, "malformed.wav");
	const unsupported = join(root, "unsupported.wav");
	const external = join(root, "external.ffconcat");
	const repeated = join(root, "JFK repeated.wav");
	encode(opus, "-i", jfk, "-ar", "48000", "-ac", "2", "-c:a", "libopus");
	encode(movie, "-f", "lavfi", "-i", "color=size=32x32:duration=11", "-i", jfk, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=11",
		"-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "mpeg4", "-c:a", "aac", "-ar", "48000", "-disposition:a:0", "0", "-disposition:a:1", "default");
	encode(noAudio, "-f", "lavfi", "-i", "color=size=32x32:duration=0.1", "-c:v", "mpeg4");
	encode(repeated, "-stream_loop", "3", "-i", jfk, "-c:a", "pcm_s16le");
	await writeFile(malformed, "broken wav");
	const unknown = Buffer.concat([wavHeader(800), Buffer.alloc(800, 1)]);
	unknown.writeUInt16LE(0xdead, 20);
	await writeFile(unsupported, unknown);
	await writeFile(external, "ffconcat version 1.0\nfile 'JFK speech.opus'\n");
	const media = await Promise.all([opus, noAudio, malformed, unsupported, external, movie].map(async (path) => ({ path, sha256: await sha(path) })));
	const recognition = [];
	const unsubscribe = observeRecognition((event) => { if (event.kind === "final") recognition.push(event); });
	const mixedIds = await importFiles(media.map(({ path }) => path), choice, signal);
	const rows = await Promise.all(mixedIds.map((id) => until(id, terminal)));
	const completed = await Promise.all([0, 5].map((i) => inspect(rows[i], media[i], recognition)));
	const errors = [];
	for (let i = 1; i < 5; i++) {
		const row = rows[i];
		assert.equal(row.state, "asr-failed");
		assert.equal(row.wav, null);
		assert.equal(await sha(media[i].path), media[i].sha256);
		errors.push({ filename: row.filename, state: row.state, wav: row.wav, unchangedSha256: media[i].sha256, detail: stableError(getImportError(row.id)) });
	}
	assert.match(errors[0].detail, /no audio track/);
	assert.match(errors[2].detail, /no decoder found|decoder.*(?:codec|not found)|unsupported codec/i);
	assert.match(errors[3].detail, /concat.*not on whitelist/i);

	const repeatedBefore = await sha(repeated);
	const progress = [];
	const long = new MediaImportService((audio, selected, kind, writeProgress, active) => recognizeFile(audio, selected, kind, (done, total) => {
		progress.push([done, total]);
		// A foreground reservation between real inference chunks pauses the
		// following chunk. This is not an observation of a Pi live take.
		if (done < total) setForeground(true);
		writeProgress(done, total);
	}, active));
	const [id] = await long.importFiles([repeated], choice, signal);
	const running = await until(id, (row) => row.state === "recognizing" && row.doneSamples > 0 || terminal(row));
	assert.equal(running.state, "recognizing");
	assert.ok(running.doneSamples < running.totalSamples);
	long.cancelJob(id);
	const canceled = await until(id, terminal);
	assert.equal(canceled.state, "canceled");
	assert.equal(canceled.raw, null);
	assert.ok(await verifiedAudio(id, signal));
	setForeground(false);
	await retry(id, choice, signal);
	const retried = await until(id, terminal);
	assert.equal(retried.state, "ready");
	assert.equal(retried.wav.sha256, canceled.wav.sha256);
	assert.equal(retried.doneSamples, retried.totalSamples);
	assert.match(retried.raw, /fellow Americans/i);
	unsubscribe();

	await applyPrune(await previewPrune("count:0"), signal);
	const retained = (await page(null)).filter((row) => row.wav !== null).length;
	assert.equal(retained, 3);
	await deleteRow(id, signal);
	assert.equal(await verifiedAudio(id, signal), null);
	assert.equal((await page(null)).some((row) => row.id === id), false);
	const hookInvoked = (await readdir(root)).includes(basename(hookCount));
	assert.equal(hookInvoked, false);
	assert.equal(await sha(jfk), jfkHash);
	assert.equal(await sha(model), modelHash);
	assert.equal(await sha(repeated), repeatedBefore);
	return { build: { whisperSha256: await sha(binary), modelSha256: modelHash,
		ffmpegVersion: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0], importerSha256: await sha(new URL("../../src/transfer/import.ts", import.meta.url)) },
		rig: { os: `${platform()} ${release()}`, arch: arch(), cpu: cpus()[0]?.model ?? null, actualCompute: "cpu", boundDevice: null },
		publicJfkWavSha256: jfkHash, completed, errors,
		longImport: { progress, canceled: canceled.state, canceledRaw: canceled.raw, retryState: retried.state,
			verifiedWav: retried.wav, retryThrough: retried.doneSamples, retrySamples: retried.totalSamples, repeatedSpeechSha256: repeatedBefore },
		retention: { confirmedPolicy: "count:0", audioRowsBeforeExplicitDelete: retained, retryRowPresentAfterDelete: false }, fixtureOutputHookInvoked: hookInvoked };
}

const [jfk, binary, model] = process.argv.slice(2).map((file) => resolve(file));
if (!(jfk && binary && model)) throw new Error("Pass public JFK WAV, installed whisper-cli, and pinned ggml-tiny.en.bin as three explicit files.");
const cwd = process.cwd();
const root = await mkdtemp(join(tmpdir(), "micme-p7-import-evidence-"));
try { console.log(JSON.stringify(await collect(jfk, binary, model, root), null, 2)); }
finally { setForeground(false); process.chdir(cwd); await rm(root, { recursive: true, force: true }); }
