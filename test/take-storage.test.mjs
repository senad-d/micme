import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as library from "../src/transfer/library.ts";
import * as retention from "../src/transfer/retention.ts";
import { createLiveRecordingDirectory } from "../src/recording-dir.ts";
import { wavHeader } from "./live-native/corpus.mjs";

const unix = process.platform === "linux" || process.platform === "darwin";
const signal = new AbortController().signal;
const final = { raw: "original text", local: "Local text.", language: "en", source: "clip", rules: [] };
const choice = { variantId: "current-model", compute: "auto", requestedDeviceId: null, language: "en", task: "transcribe", detector: "off", chunking: true };
const wav = Buffer.concat([wavHeader(8), Buffer.from([1, 0, 3, 0, 7, 0, 9, 0])]);
const sha256 = createHash("sha256").update(wav).digest("hex");
const audio = {
	bytes: wav.length, sha256,
	async copyTo(target) {
		const fd = target.createPrivateFile("snapshot.wav");
		try { writeFileSync(fd, wav); } finally { closeSync(fd); }
		return target.liveFilePath("snapshot.wav");
	},
};

async function fixture(t, values = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme-history-test-"));
	const overrides = { PI_CODING_AGENT_DIR: root, TMPDIR: root, MICME_HISTORY: "1", MICME_RETENTION: "never", ...values };
	const micmeKeys = Object.keys(process.env).filter((key) => key.startsWith("MICME_"));
	const prior = Object.fromEntries([...new Set([...micmeKeys, ...Object.keys(overrides), "PATH"])].map((key) => [key, process.env[key]]));
	for (const key of micmeKeys) delete process.env[key];
	for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
	t.after(async () => {
		for (const [key, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	const store = join(root, "micme-library");
	return { root, store, db: join(store, "history.sqlite3"), wav: (id) => join(store, `${id}.wav`) };
}

const check = (name, run) => test(name, { skip: !unix }, run);
const save = (saved = audio, state = "ready", text = final, polished) => library.saveTake(text, "clip", state, saved, "old-model", signal, polished);
const rows = () => library.page(null);
const preview = (policy) => retention.previewPrune(policy);
const apply = (plan) => retention.applyPrune(plan, signal);
const start = () => retention.enforceActiveRetention(signal);

check("history off and enabled startup without a library create nothing", async (t) => {
	const { root } = await fixture(t, { MICME_HISTORY: "0" });
	await mkdir(join(root, "micme-rec"));
	await writeFile(join(root, "micme-rec", "old.wav"), wav);
	await start();
	assert.deepEqual(await rows(), []);
	await assert.rejects(save(), /history is disabled/i);
	assert.deepEqual(await readdir(root), ["micme-rec"]);
	process.env.MICME_HISTORY = "1";
	await start();
	assert.deepEqual(await readdir(root), ["micme-rec"]);
});

check("publishes a private SQLite v1 take with raw, local, polished and a verified WAV", async (t) => {
	const files = await fixture(t);
	const id = await save(audio, "ready", final, "Polished text.");
	const [row] = await rows();
	assert.deepEqual([row.id, row.raw, row.local, row.polished, row.wav], [id, final.raw, final.local, "Polished text.", { bytes: wav.length, sha256 }]);
	for (const [path, mode] of [[files.store, 0o700], [files.db, 0o600], [files.wav(id), 0o600]]) {
		assert.equal((await lstat(path)).mode & 0o777, mode);
	}
	const db = new DatabaseSync(files.db, { readOnly: true });
	try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1); } finally { db.close(); }
	const receipt = await library.verifiedAudio(id, signal);
	const spool = await createLiveRecordingDirectory(".", false, "micme-history-test-copy-");
	try {
		const copied = spool.openVerifiedFile(await receipt.copyTo(spool, signal));
		try {
			assert.equal(copied.size(), wav.length);
			const bytes = Buffer.alloc(wav.length);
			assert.equal(await copied.readAt(bytes, 0), wav.length);
			assert.deepEqual(bytes, wav);
		} finally { copied.close(); }
	} finally { await spool.remove(); spool.close(); }
});

check("a partial or mismatched copy throws and leaves no take or owned WAV", async (t) => {
	const files = await fixture(t);
	const broken = { ...audio, copyTo: async (target) => { await audio.copyTo(target); throw new Error("simulated disk error"); } };
	await assert.rejects(save(broken));
	await assert.rejects(save({ ...audio, sha256: "0".repeat(64) }));
	assert.deepEqual(await rows(), []);
	assert.deepEqual((await readdir(files.store)).filter((name) => name.endsWith(".wav") || name.endsWith(".part")), []);
});

check("confirmed count:0 returns a pruned null and later updates cannot recreate a row", async (t) => {
	const files = await fixture(t);
	await apply(await preview("count:0"));
	assert.equal(await save(audio, "ready", final, "Polished text."), null);
	assert.deepEqual(await rows(), []);
	assert.deepEqual(await readdir(files.store), ["history.sqlite3"]);
});

check("a confirmed never policy stops a previously confirmed count policy", async (t) => {
	await fixture(t);
	await apply(await preview("count:0"));
	assert.equal(await save(), null);
	await apply(await preview("never"));
	const id = await save();
	await start();
	assert.equal((await rows())[0].id, id);
});

check("a confirmed count survives subsequent saves and startup, protecting stars and imports", async (t) => {
	const files = await fixture(t);
	const keep = await save();
	await library.star(keep, true, signal);
	const imported = await library.enqueueImport("/chosen/keep input.wav", choice, signal);
	await library.publishAudio(imported, audio, signal);
	await apply(await preview("count:1"));
	const old = await save();
	const latest = await save();
	await start();
	assert.deepEqual(new Set((await rows()).map((row) => row.id)), new Set([keep, imported, latest]));
	await assert.rejects(lstat(files.wav(old)), { code: "ENOENT" });
	await library.updateTake(old, { local: "don't resurrect" }, signal);
	assert.equal((await rows()).some((row) => row.id === old), false);
	await library.star(keep, false, signal);
	await assert.rejects(lstat(files.wav(keep)), { code: "ENOENT" });
	assert.ok((await lstat(files.wav(latest))).isFile());
});

check("a stale or canceled confirmation cannot install a destructive policy; a config value is not confirmation", async (t) => {
	await fixture(t, { MICME_RETENTION: "count:0" });
	const first = await save();
	const proposed = await preview("count:0");
	assert.deepEqual(proposed, { ids: [first], bytes: wav.length, policy: "count:0" });
	await assert.rejects(retention.applyPrune(proposed, AbortSignal.abort()), { name: "AbortError" });
	const next = await save();
	await assert.rejects(apply(proposed), /preview/i);
	await start();
	assert.deepEqual(new Set((await rows()).map((row) => row.id)), new Set([first, next]));
});

check("an enabled startup expires a confirmed age policy, without pruning while disabled", async (t) => {
	const files = await fixture(t);
	const id = await save();
	await apply(await preview("days:3"));
	const db = new DatabaseSync(files.db);
	try { db.prepare("UPDATE takes SET created_utc = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", id); }
	finally { db.close(); }
	process.env.MICME_HISTORY = "0";
	await start();
	assert.deepEqual(await readFile(files.wav(id)), wav);
	process.env.MICME_HISTORY = "1";
	await start();
	assert.deepEqual(await rows(), []);
	await assert.rejects(lstat(files.wav(id)), { code: "ENOENT" });
});

check("a stale audio receipt refuses even an identical replacement and keeps copyable text", async (t) => {
	const files = await fixture(t);
	const id = await save(audio, "delivery-failed");
	const receipt = await library.verifiedAudio(id, signal);
	await rename(files.wav(id), join(files.store, "moved.wav"));
	await writeFile(files.wav(id), wav, { mode: 0o600 });
	assert.equal(await library.verifiedAudio(id, signal), null);
	const [row] = await rows();
	assert.equal(row.local, final.local);
	assert.equal(row.wav, null);
	const spool = await createLiveRecordingDirectory(".", false, "micme-history-test-copy-");
	try { await assert.rejects(receipt.copyTo(spool, signal), /audio/i); }
	finally { await spool.remove(); spool.close(); }
	await assert.rejects(library.deleteRow(id, signal), /audio/i);
	assert.deepEqual(await readFile(files.wav(id)), wav);
});

check("age-sensitive reads expire eligible audio without waiting for a save or a restart", async (t) => {
	const files = await fixture(t);
	const id = await save();
	await apply(await preview("days:14"));
	const db = new DatabaseSync(files.db);
	try { db.prepare("UPDATE takes SET created_utc = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", id); }
	finally { db.close(); }
	assert.equal(await library.verifiedAudio(id, signal), null);
	await assert.rejects(lstat(files.wav(id)), { code: "ENOENT" });
});

check("pagination is newest first with a deterministic ID tie-break and a 20-row limit", async (t) => {
	const files = await fixture(t);
	const ids = await Promise.all(Array.from({ length: 21 }, () => save(null)));
	const db = new DatabaseSync(files.db);
	try { db.exec("UPDATE takes SET created_utc = '2020-01-01T00:00:00.000Z'"); } finally { db.close(); }
	const first = (await rows()).map((row) => row.id);
	const second = (await library.page(first.at(-1))).map((row) => row.id);
	assert.deepEqual(first, ids.sort().reverse().slice(0, 20));
	assert.deepEqual(second, ids.slice(20));
});

check("a missing WAV is not retryable and does not erase text", async (t) => {
	const files = await fixture(t);
	const id = await save(audio, "delivery-failed");
	await rm(files.wav(id));
	assert.equal(await library.verifiedAudio(id, signal), null);
	assert.equal((await rows())[0].local, final.local);
	await library.deleteRow(id, signal);
	assert.deepEqual(await rows(), []);
});

check("a symlink at the library root is refused before SQLite or WAV publication", async (t) => {
	const files = await fixture(t);
	const other = join(files.root, "alternate");
	await mkdir(other, { mode: 0o700 });
	await symlink(other, files.store, "dir");
	await assert.rejects(save(), /history/i);
	assert.deepEqual(await readdir(other), []);
});

check("a root swapped while copying publishes neither a row nor audio into the replacement", async (t) => {
	const files = await fixture(t);
	const saved = await save();
	const moved = join(files.root, "old-library");
	const swapped = { ...audio, async copyTo(target) {
		const result = await audio.copyTo(target);
		await rename(files.store, moved);
		await mkdir(files.store, { mode: 0o700 });
		return result;
	} };
	await assert.rejects(save(swapped), /private local history store/i);
	assert.deepEqual(await readdir(files.store), []);
	assert.deepEqual(await readFile(join(moved, `${saved}.wav`)), wav);
	await rm(files.store, { recursive: true });
	await rename(moved, files.store);
	assert.deepEqual((await rows()).map(({ id }) => id), [saved]);
});

check("an aborted source copy never publishes a take", async (t) => {
	const files = await fixture(t);
	const controller = new AbortController();
	const cancelled = { ...audio, async copyTo(target) {
		const result = await audio.copyTo(target);
		controller.abort();
		return result;
	} };
	await assert.rejects(library.saveTake(null, "live", "asr-failed", cancelled, null, controller.signal), { name: "AbortError" });
	assert.deepEqual(await rows(), []);
	assert.deepEqual(await readdir(files.store), ["history.sqlite3"]);
});

const childImports = `
	import { closeSync, writeFileSync } from 'node:fs';
	import { createHash } from 'node:crypto';
	import { PosixDirectory } from ${JSON.stringify(new URL("../src/posix-directory.ts", import.meta.url).href)};
	import * as library from ${JSON.stringify(new URL("../src/transfer/library.ts", import.meta.url).href)};
	import * as retention from ${JSON.stringify(new URL("../src/transfer/retention.ts", import.meta.url).href)};
	const signal = new AbortController().signal;
	const wav = Buffer.from(${JSON.stringify(wav.toString("base64"))}, 'base64');
	const audio = { bytes: wav.length, sha256: createHash('sha256').update(wav).digest('hex'), async copyTo(target) {
		const fd = target.createPrivateFile('restart-fixture.wav');
		try { writeFileSync(fd, wav); } finally { closeSync(fd); }
		return target.liveFilePath('restart-fixture.wav');
	} };
`;

function runChild(script) {
	return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", childImports + script], { encoding: "utf8", timeout: 5000 });
}

function interruptedAfterMove(src, dst) {
	return `
		const move = PosixDirectory.prototype.moveExclusive;
		PosixDirectory.prototype.moveExclusive = function (name, target) {
			move.call(this, name, target);
			if (name.endsWith(${JSON.stringify(src)}) && target.endsWith(${JSON.stringify(dst)})) process.kill(process.pid, 'SIGKILL');
		};`;
}

check("restart reconciles an install interrupted between WAV publication and row commit", async (t) => {
	const files = await fixture(t);
	const crashed = runChild(interruptedAfterMove(".part", ".wav") + `
		await library.saveTake(null, 'clip', 'asr-failed', audio, null, signal);`);
	assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
	assert.equal((await readdir(files.store)).filter((name) => name.endsWith(".wav")).length, 1);
	const started = runChild(`await retention.enforceActiveRetention(signal);`);
	assert.equal(started.status, 0, started.stderr);
	assert.deepEqual(await readdir(files.store), ["history.sqlite3"]);
	assert.deepEqual(await rows(), []);
});

check("restart finishes deletion of the claimed original without touching a new WAV at its old name", async (t) => {
	const files = await fixture(t);
	const id = await save();
	const crashed = runChild(interruptedAfterMove(".wav", ".deleting") + `await library.deleteRow(${JSON.stringify(id)}, signal);`);
	assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
	const claimed = join(files.store, `${id}.deleting`);
	assert.deepEqual(await readFile(claimed), wav);
	await writeFile(files.wav(id), "replacement", { mode: 0o600 });
	const started = runChild(`await retention.enforceActiveRetention(signal);`);
	assert.equal(started.status, 0, started.stderr);
	assert.deepEqual(await rows(), []);
	await assert.rejects(lstat(claimed), { code: "ENOENT" });
	assert.equal(await readFile(files.wav(id), "utf8"), "replacement");
});

check("after restart an unfinished import without published audio is interrupted, not retryable", async (t) => {
	await fixture(t);
	const prior = runChild(`await library.enqueueImport('/selected/private source.wav', ${JSON.stringify(choice)}, signal);`);
	assert.equal(prior.status, 0, prior.stderr);
	await start();
	const [row] = await rows();
	assert.deepEqual([row.state, row.filename, row.modelId, row.wav], ["interrupted", "private source.wav", choice.variantId, null]);
	assert.equal(await library.verifiedAudio(row.id, signal), null);
});

async function waitFor(observe) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const value = await observe();
		if (value) return value;
		await delay(20);
	}
	throw new Error("Timed out waiting for the fixture action");
}

check("retry uses the current choice, exposes progress and commits a new final", async (t) => {
	await fixture(t);
	const id = await save(audio, "asr-failed", null);
	await start();
	const { resolve, promise } = Promise.withResolvers();
	const run = library.retryWith(id, choice, signal, async (input, selected, job, progress) => {
		assert.equal(input.sha256, sha256);
		assert.deepEqual(selected, choice);
		assert.equal(job, "retry");
		progress(2, 4);
		await promise;
		progress(4, 4);
		return final;
	});
	try {
		const active = await waitFor(async () => (await rows()).find((row) => row.doneSamples === 2));
		assert.deepEqual([active.state, active.totalSamples], ["recognizing", 4]);
	} finally { resolve(); await run; }
	const [row] = await rows();
	assert.deepEqual([row.id, row.state, row.local, row.modelId, row.doneSamples], [id, "ready", final.local, choice.variantId, 4]);
});

check("retry failure or cancellation never replaces an earlier final", async (t) => {
	await fixture(t);
	const id = await save(audio, "delivery-failed", final, "polished before retry");
	const [initial] = await rows();
	await assert.rejects(library.retryWith(id, choice, signal, async () => { throw new Error("decoder failed"); }), /decoder failed/);
	assert.deepEqual(await rows(), [initial]);
	const controller = new AbortController();
	await assert.rejects(library.retryWith(id, choice, controller.signal, async () => {
		controller.abort();
		return { ...final, raw: "must not be stored" };
	}), { name: "AbortError" });
	assert.deepEqual(await rows(), [initial]);
});

check("a retry finishing after explicit deletion cannot recreate a row", async (t) => {
	await fixture(t);
	const id = await save(audio, "asr-failed", null);
	const started = Promise.withResolvers();
	const finish = Promise.withResolvers();
	const run = library.retryWith(id, choice, signal, async () => {
		started.resolve();
		await finish.promise;
		return final;
	});
	const rejected = assert.rejects(run, /take is no longer available/);
	try {
		await Promise.race([started.promise, run]);
		await library.deleteRow(id, signal);
	} finally { finish.resolve(); await rejected; }
	assert.deepEqual(await rows(), []);
});

check("playback passes the seek and verified bytes to the local player and abort stops it", async (t) => {
	const files = await fixture(t);
	const id = await save(audio, "asr-failed", null);
	await start();
	const player = join(files.root, "ffplay");
	const observed = join(files.root, "playback.json");
	await writeFile(player, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify([args[args.indexOf('-ss') + 1], fs.readFileSync(args.at(-1)).toString('hex')]));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
	process.env.PATH = files.root;
	const controller = new AbortController();
	const playing = library.play(id, 250, controller.signal);
	const stopped = assert.rejects(playing, { name: "AbortError" });
	try {
		const launched = await waitFor(() => readFile(observed, "utf8").catch(() => null));
		assert.deepEqual(JSON.parse(launched), ["0.25", wav.toString("hex")]);
	} finally { controller.abort(); await stopped; }
});
