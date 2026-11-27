import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deferred } from "../src/processes.ts";
import { MediaImportService, cancelJob, getImportError, importFiles } from "../src/transfer/import.ts";
import { RecognitionQueue } from "../src/transfer/jobs.ts";
import { deleteRow, page, retryWith, verifiedAudio } from "../src/transfer/library.ts";
import { withVerifiedPcm } from "../src/transfer/recognition-audio.ts";
import { createRecognitionService } from "../src/transfer/recognition.ts";
import { applyPrune, previewPrune } from "../src/transfer/retention.ts";
import { wavHeader } from "./live-native/corpus.mjs";
import { readJsonl, validateScorecardRow } from "./live-native/transfer-schema.mjs";

const unix = process.platform === "linux" || process.platform === "darwin";
const hasFdProtocol = (result) => result.stdout?.split(/\s+/).includes("fd");
const hasFfmpeg = unix && hasFdProtocol(spawnSync("ffmpeg", ["-hide_banner", "-protocols"], { encoding: "utf8" }));
const hasFfprobe = unix && hasFdProtocol(spawnSync("ffprobe", ["-hide_banner", "-protocols"], { encoding: "utf8" }));
const mediaSkip = !unix ? "the private library uses POSIX descriptors" : !(hasFfmpeg && hasFfprobe) && "requires FFmpeg and ffprobe with seekable fd: support";
const mediaTest = (name, run) => test(name, { skip: mediaSkip, timeout: 20_000 }, run);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const model = (variantId) => ({ variantId, compute: "auto", requestedDeviceId: null, language: "en", task: "transcribe", detector: "off", chunking: false });
const choice = model("first-model");
const text = { raw: "imported words", local: "Imported words.", language: "en", source: "import", rules: [], actualCompute: "cpu", boundDevice: null };
const wav = (seconds) => {
	const pcm = Buffer.alloc(seconds * 32_000, 1);
	return Buffer.concat([wavHeader(pcm.length), pcm]);
};

async function fixture(t, config = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme-import-test-"));
	const overrides = { PI_CODING_AGENT_DIR: root, TMPDIR: root, MICME_HISTORY: "1", MICME_RETENTION: "never", ...config };
	const micmeKeys = Object.keys(process.env).filter((key) => key.startsWith("MICME_"));
	const prior = new Map([...new Set([...micmeKeys, ...Object.keys(overrides), "PATH"])].map((key) => [key, process.env[key]]));
	for (const key of micmeKeys) delete process.env[key];
	Object.assign(process.env, overrides);
	const abort = new AbortController();
	t.after(async () => {
		abort.abort();
		for (const [key, value] of prior) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	return { root, store: join(root, "micme-library"), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) };
}

function encode(path, ...args) {
	const result = spawnSync("ffmpeg", ["-nostdin", "-v", "error", ...args, path], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

async function untilRow(id, predicate, signal) {
	while (true) {
		signal.throwIfAborted();
		const row = (await page(null)).find((entry) => entry.id === id);
		if (row && predicate(row)) return row;
		await delay(10, undefined, { signal });
	}
}

const terminal = (row) => ["ready", "asr-failed", "save-failed", "interrupted", "canceled"].includes(row.state);

function memoryAudio(bytes) {
	return { bytes: bytes.length, sha256: sha(bytes), copyTo: async (directory) => {
		const fd = directory.createPrivateFile("test.wav");
		try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
		return directory.liveFilePath("test.wav");
	} };
}

test("P7 import scorecard observations meet the shared schema and resolve public evidence", async () => {
	const bundle = new URL("./live-native/", import.meta.url);
	const rows = await readJsonl(new URL("transfer-q-p7-import.jsonl", bundle), validateScorecardRow);
	assert.ok(rows.length > 0);
	for (const row of rows) {
		assert.deepEqual([row.phase, row.feature], [7, "F1"]);
		assert.ok(row.evidence.length > 0);
		await Promise.all(row.evidence.map((file) => access(new URL(file, bundle))));
	}
});

test("import requires an opted-in library before creating files or jobs", async (t) => {
	const { root, signal } = await fixture(t, { MICME_HISTORY: "0" });
	await assert.rejects(importFiles([join(root, "source.wav")], choice, signal), /history must be enabled/);
	assert.deepEqual(await readdir(root), []);
});

test("missing local decoder tools leave a per-file prerequisite error instead of partial audio", { skip: !unix }, async (t) => {
	const { root, signal } = await fixture(t);
	const path = join(root, "source.wav");
	await writeFile(path, wav(0.25));
	process.env.PATH = join(root, "empty-bin");
	const [id] = await importFiles([path], choice, signal);
	const row = await untilRow(id, terminal, signal);
	assert.equal(row.state, "asr-failed");
	assert.equal(row.wav, null);
	assert.match(getImportError(id), /requires installed FFmpeg and ffprobe/);
});

mediaTest("mixed Opus and video normalize to verified PCM from the first audio track, not the default track", async (t) => {
	const { root, signal } = await fixture(t);
	const opus = join(root, "clip voice.opus");
	const video = join(root, "camera clip.mp4");
	encode(opus, "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=0.25", "-ac", "2", "-c:a", "libopus");
	encode(video, "-f", "lavfi", "-i", "color=size=32x32:duration=0.25", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=0.25",
		"-f", "lavfi", "-i", "sine=sample_rate=48000:duration=0.25", "-map", "0:v", "-map", "1:a", "-map", "2:a",
		"-c:v", "mpeg4", "-c:a", "aac", "-disposition:a:0", "0", "-disposition:a:1", "default");
	const before = await Promise.all([readFile(opus), readFile(video)]);
	const samples = [];
	const imports = new MediaImportService((audio, _choice, _job, progress, signal) => withVerifiedPcm(audio, signal, async (pcm) => {
		const bytes = await pcm.read(0, pcm.total, signal);
		samples.push(bytes.some(Boolean));
		progress(pcm.total, pcm.total);
		return text;
	}));
	const ids = await imports.importFiles([opus, video], choice, signal);
	const rows = await Promise.all(ids.map((id) => untilRow(id, terminal, signal)));
	assert.deepEqual(rows.map(({ state }) => state), ["ready", "ready"], ids.map((id) => imports.getImportError(id)).join("; "));
	assert.deepEqual(rows.map(({ filename }) => filename), ["clip voice.opus", "camera clip.mp4"]);
	assert.deepEqual(samples, [true, false], "the first video audio track is silent, the default audio track is not");
	for (const { raw, local, doneSamples, totalSamples, wav } of rows) {
		assert.deepEqual([raw, local], [text.raw, text.local]);
		assert.equal(doneSamples, totalSamples);
		assert.ok(wav.bytes > 44 && doneSamples > 0);
	}
	assert.deepEqual(await Promise.all([readFile(opus), readFile(video)]), before);
});

mediaTest("per-file failures reject remote paths, local references, malformed media and video without audio without stopping a valid sibling", async (t) => {
	const { root, store, signal } = await fixture(t);
	const valid = join(root, "valid.wav");
	const list = join(root, "external.ffconcat");
	const invalid = join(root, "broken.wav");
	const video = join(root, "no audio.mp4");
	const linked = join(root, "symlink.wav");
	const original = wav(0.25);
	await writeFile(valid, original);
	await symlink(valid, linked);
	await writeFile(list, "ffconcat version 1.0\nfile 'valid.wav'\n");
	const positive = spawnSync("ffprobe", ["-v", "error", "-f", "concat", "-show_entries", "stream=codec_name", list], { encoding: "utf8" });
	assert.equal(positive.status, 0, positive.stderr);
	assert.match(positive.stdout, /pcm_s16le/);
	await writeFile(invalid, original.subarray(0, original.length - 2031));
	encode(video, "-f", "lavfi", "-i", "color=size=32x32:duration=0.25", "-c:v", "mpeg4");
	const imports = new MediaImportService(async () => text);
	const ids = await imports.importFiles(["https://example.invalid/media.wav", linked, list, invalid, video, valid], choice, signal);
	const rows = await Promise.all(ids.map((id) => untilRow(id, terminal, signal)));
	for (const row of rows.slice(0, -1)) {
		assert.equal(row.state, "asr-failed", imports.getImportError(row.id) ?? row.filename);
		assert.equal(row.wav, null);
	}
	const errors = ids.map((id) => imports.getImportError(id));
	assert.match(errors[0], /regular local file/);
	assert.match(errors[1], /regular local file/);
	assert.match(errors[2], /concat.*not on whitelist/i);
	assert.match(errors[3], /corrupt|invalid|truncated|error/i);
	assert.match(errors[4], /no audio track/);
	assert.equal(rows.at(-1).state, "ready");
	assert.deepEqual((await readdir(store)).sort(), [`${ids.at(-1)}.wav`, "history.sqlite3"].sort());
	assert.deepEqual(await readFile(valid), original);
});

mediaTest("unsupported codecs preserve the actual decoder diagnostic and never publish audio", async (t) => {
	const { root, signal } = await fixture(t);
	const bytes = wav(0.25);
	bytes.writeUInt16LE(0xdead, 20); // Unknown WAV format tag, but a recognizable WAV container.
	const path = join(root, "unsupported.wav");
	await writeFile(path, bytes);
	const [id] = await importFiles([path], choice, signal);
	const row = await untilRow(id, terminal, signal);
	assert.equal(row.state, "asr-failed");
	assert.equal(row.wav, null);
	assert.match(getImportError(id), /no decoder found|decoder.*(?:codec|not found)|unsupported codec/i);
	assert.deepEqual(await readFile(path), bytes);
});

mediaTest("a queued import refuses a replacement file even when its bytes are identical", async (t) => {
	const { root, signal } = await fixture(t);
	const path = join(root, "original.wav");
	const queued = join(root, "queued.wav");
	const replacement = join(root, "replacement.wav");
	const bytes = wav(0.25);
	await Promise.all([path, queued, replacement].map((file) => writeFile(file, bytes)));
	const gate = deferred();
	const imports = new MediaImportService(async () => { await gate.promise; return text; });
	const [id, next] = await imports.importFiles([path, queued], choice, signal);
	try {
		await untilRow(id, (row) => row.state === "recognizing", signal);
		await rename(replacement, queued);
	} finally { gate.resolve(); }
	assert.equal((await untilRow(id, terminal, signal)).state, "ready");
	const row = await untilRow(next, terminal, signal);
	assert.equal(row.wav, null);
	assert.match(imports.getImportError(next), /changed.*reselect/i);
	assert.deepEqual(await readFile(queued), bytes);
});

mediaTest("queued cancellation takes effect independently; cancellation after publication keeps only verified retry input", async (t) => {
	const { root, signal } = await fixture(t);
	const path = join(root, "source.wav");
	await writeFile(path, wav(0.25));
	const gate = deferred();
	const imports = new MediaImportService(async (_audio, _choice, kind, progress) => {
		assert.equal(kind, "import");
		progress(1000, 4000);
		await gate.promise;
		return text; // Models may return late; discard the result after cancellation.
	});
	const [active, queued] = await imports.importFiles([path, path], choice, signal);
	try {
		const inProgress = await untilRow(active, (row) => row.doneSamples === 1000, signal);
		assert.equal(inProgress.state, "recognizing");
		imports.cancelJob(queued);
		const cancelled = await untilRow(queued, terminal, signal);
		assert.equal(cancelled.state, "canceled");
		assert.equal(cancelled.wav, null);
		await assert.rejects(retryWith(queued, choice, signal, async () => text), /no longer has verified audio/);
		imports.cancelJob(active);
	} finally { gate.resolve(); }
	const canceled = await untilRow(active, terminal, signal);
	assert.equal(canceled.state, "canceled");
	assert.equal(canceled.raw, null);
	assert.equal(canceled.doneSamples, 1000);
	const retryChoice = model("explicit-retry-model");
	await retryWith(active, retryChoice, signal, async (audio, selected, kind) => {
		assert.equal(audio.sha256, canceled.wav.sha256);
		assert.equal(selected.variantId, retryChoice.variantId);
		assert.equal(kind, "retry");
		return text;
	});
	const row = (await page(null)).find(({ id }) => id === active);
	assert.deepEqual([row.state, row.modelId, row.raw], ["ready", retryChoice.variantId, text.raw]);
});

async function fixtureDecoder(root, program) {
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "ffmpeg"), `#!${process.execPath}\nconst fs = require('node:fs');\n${program}\n`, { mode: 0o700 });
	process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
}

mediaTest("canceling an active decoder stops the owned process and discards its private partial output", async (t) => {
	const { root, store, signal } = await fixture(t);
	const path = join(root, "source.wav");
	const marker = join(root, "decoder-pid");
	const bytes = wav(0.25);
	await writeFile(path, bytes);
	await fixtureDecoder(root, `fs.writeSync(1, 'RIFFpartial');\nfs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);`);
	const [id] = await importFiles([path], choice, signal);
	let pid;
	try {
		while (!(pid = Number(await readFile(marker, "utf8").catch(() => "")))) await delay(10, undefined, { signal });
		assert.equal((await untilRow(id, (row) => row.state === "decoding", signal)).wav, null);
	} finally { cancelJob(id); }
	assert.equal((await untilRow(id, terminal, signal)).state, "canceled");
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	assert.deepEqual(await readdir(store), ["history.sqlite3"]);
	assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("micme-import-")), []);
	assert.deepEqual(await readFile(path), bytes);
});

mediaTest("verification refuses a valid replacement at the private decoder output name", async (t) => {
	const { root, store, signal } = await fixture(t);
	const path = join(root, "source.wav");
	const marker = join(root, "decoder-ready");
	const release = join(root, "decoder-close");
	const bytes = wav(0.25);
	await writeFile(path, bytes);
	await fixtureDecoder(root, `fs.writeFileSync(1, fs.readFileSync(0));\nfs.writeFileSync(${JSON.stringify(marker)}, 'ready');\nsetInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);`);
	const imports = new MediaImportService(async () => assert.fail("attempted inference from a replacement WAV"));
	const [id] = await imports.importFiles([path], choice, signal);
	try {
		while (!await readFile(marker).catch(() => null)) await delay(10, undefined, { signal });
		const staging = (await readdir(root)).find((name) => name.startsWith("micme-import-"));
		assert.ok(staging);
		const target = join(root, staging, "normalized.wav");
		await rename(target, join(root, staging, "original.wav"));
		await writeFile(target, bytes, { mode: 0o600 });
	} finally { await writeFile(release, "close"); }
	const row = await untilRow(id, terminal, signal);
	assert.equal(row.wav, null);
	assert.match(imports.getImportError(id), /normalized WAV was replaced/);
	assert.deepEqual(await readdir(store), ["history.sqlite3"]);
	assert.deepEqual(await readFile(path), bytes);
});

mediaTest("real process exit leaves distinct interrupted rows with and without verified WAVs", async (t) => {
	const { root, signal } = await fixture(t);
	const path = join(root, "source.wav");
	await writeFile(path, wav(0.25));
	const worker = fileURLToPath(new URL("./media-import-child.mjs", import.meta.url));
	const child = spawn(process.execPath, [worker, path, JSON.stringify(choice)], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = once(child, "exit");
	let active, queued;
	try {
		child.stdout.setEncoding("utf8");
		const [output] = await once(child.stdout, "data", { signal });
		[active, queued] = JSON.parse(output);
		assert.equal((await untilRow(active, (row) => row.state === "recognizing", signal)).state, "recognizing");
	} finally { child.kill("SIGKILL"); await exit; }
	const rows = await Promise.all([active, queued].map((id) => untilRow(id, terminal, signal)));
	assert.deepEqual(rows.map(({ state }) => state), ["interrupted", "interrupted"]);
	assert.ok(await verifiedAudio(active, signal));
	assert.equal(await verifiedAudio(queued, signal), null);
});

mediaTest("imports survive confirmed automatic retention and can be explicitly deleted with their WAVs", async (t) => {
	const { root, store, signal } = await fixture(t);
	const path = join(root, "source.wav");
	await writeFile(path, wav(0.25));
	await applyPrune(await previewPrune("count:0"), signal);
	const imports = new MediaImportService(async () => text);
	const [id] = await imports.importFiles([path], choice, signal);
	assert.equal((await untilRow(id, terminal, signal)).state, "ready");
	assert.deepEqual((await previewPrune("days:3")).ids, []);
	assert.ok(await verifiedAudio(id, signal));
	await deleteRow(id, signal);
	assert.deepEqual(await page(null), []);
	assert.deepEqual(await readdir(store), ["history.sqlite3"]);
});

class BatchAdapter {
	traits = { stream: false, batch: true, longForm: false, nativeLid: false, bias: false, translateEn: false, languages: ["en"], vad: "off", actualCompute: "cpu", boundDevice: null };
	maxInputSamples = 80 * 16_000;
	pcm = Buffer.alloc(0);

	constructor(run) { this.run = run; }
	async batch(pcm) {
		this.pcm = pcm;
		await this.run(pcm.length / 2);
		return "imported words";
	}
	async reset() {}
	async close() {}
	evidence() { return { inputSamples: this.pcm.length / 2, inputPcmSha256: sha(this.pcm) }; }
}

mediaTest("whole-take selections still yield at import chunk boundaries to foreground, retries, and FIFO imports", async (t) => {
	const { root, signal } = await fixture(t);
	const first = join(root, "long.wav");
	const second = join(root, "short.wav");
	const short = wav(0.25);
	await writeFile(first, wav(42));
	await writeFile(second, short);
	const entered = deferred();
	const finishChunk = deferred();
	const retryWaiting = deferred();
	const queue = new RecognitionQueue();
	const acquire = queue.acquire.bind(queue);
	queue.acquire = (priority, active) => {
		const ready = acquire(priority, active);
		if (priority === "retry") retryWaiting.resolve();
		return ready;
	};
	const order = [];
	const api = createRecognitionService({ queue, settings: () => ({ MICME_MODEL_IDLE: "5min", MICME_PREFERRED_LANGUAGES: [], MICME_WORDS: [] }),
		load: async ({ variantId }) => new BatchAdapter(async (samples) => {
			order.push([variantId, samples]);
			if (order.length === 1) { entered.resolve(); await finishChunk.promise; }
		}) });
	t.after(() => api.unload());
	const imports = new MediaImportService(api.recognizeFile);
	const selected = { ...choice };
	const [id] = await imports.importFiles([first], selected, signal);
	try {
		selected.variantId = "mutated-global-model";
		const [later] = await imports.importFiles([second], model("later-import"), signal);
		await entered.promise;
		const shortAudio = memoryAudio(short);
		queue.setForeground(true);
		const foreground = api.openRecognizer(model("foreground"), () => {}, signal);
		const retry = api.recognizeFile(shortAudio, model("explicit-retry"), "retry", () => {}, signal);
		await retryWaiting.promise;
		assert.deepEqual(order, [[choice.variantId, 640_000]]);
		finishChunk.resolve();
		const dictation = await foreground;
		await dictation.push(0, short.subarray(44), signal);
		await dictation.finish(shortAudio, signal);
		queue.setForeground(false);
		await retry;
		assert.equal((await untilRow(id, terminal, signal)).modelId, choice.variantId);
		assert.equal((await untilRow(later, terminal, signal)).state, "ready");
		assert.deepEqual(order, [[choice.variantId, 640_000], ["foreground", 4_000], ["explicit-retry", 4_000], [choice.variantId, 32_000], ["later-import", 4_000]]);
	} finally { finishChunk.resolve(); queue.setForeground(false); }
});
