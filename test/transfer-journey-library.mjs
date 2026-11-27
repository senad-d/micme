import assert from "node:assert/strict";
import { closeSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { writeMicmeConfigValues } from "../src/config.ts";
import { files, fullInput, publicText, sha, wav } from "./transfer-journey-fixtures.mjs";
import { assertUntouched, coldLibraryRestart, isolatedJourney, prompt, take, until } from "./transfer-journey-harness.mjs";

const posix = { skip: process.platform === "win32" && "requires POSIX recorder fixtures" };
const day = 86_400_000;
const jan = Date.UTC(2025, 0, 1);
const library = () => import("../src/transfer/library.ts");

export async function readRows() {
	const { page } = await library();
	assert.equal(typeof page, "function", "L library listing is not implemented yet");
	return page(null);
}

export async function leave(ui, pending) {
	for (let n = 0; n < 8 && ui.dialogs.current; n++) ui.dialogs.input("\x1b");
	assert.equal(ui.dialogs.current, undefined, "Pi dialog did not close on Escape");
	await pending;
}

async function savedWav(f, why) {
	const audio = await f.audio();
	assert.equal(audio.length, 1, why);
	assert.equal(audio[0].digest, sha(wav(fullInput)));
	return audio[0];
}

async function rowDetail(ui, label) {
	const { pending } = await ui.open("history");
	await ui.dialogs.pick(label);
	return { pending };
}

async function checkInventory(f, expected) {
	const rows = await readRows();
	assert.deepEqual(rows.map((row) => row.id).sort(), expected.map((row) => row.id).sort(), "unexpected survivors in SQLite");
	assert.deepEqual((await f.audio()).map(({ bytes, digest }) => [bytes, digest]).sort(), expected.map(({ wav: audio }) => [audio.bytes, audio.sha256]).sort(), "row deletion and WAV deletion diverged");
	return rows;
}

function checkColdInventory(snapshot, expected) {
	const wanted = expected.map(({ wav: audio }) => [audio.bytes, audio.sha256]).sort();
	assert.deepEqual(snapshot.beforeListing.map(({ bytes, digest }) => [bytes, digest]).sort(), wanted, "fresh Pi did not enforce retention at session_start");
	assert.deepEqual(snapshot.afterListing.map(({ bytes, digest }) => [bytes, digest]).sort(), wanted);
	assert.deepEqual(snapshot.rows.map(({ id }) => id).sort(), expected.map(({ id }) => id).sort());
}

async function namedTake(f, ui, text, pcmByte) {
	await take(f, ui, { text, pcmByte });
	const row = (await readRows()).find(({ raw }) => raw === text);
	assert.ok(row?.wav, `no row with audio for ${text}`);
	assert.equal(row.local, text);
	return row;
}

async function flagProtected(f, ui) {
	const star = await namedTake(f, ui, "Starred specimen.", 31);
	const { pending } = await rowDetail(ui, /Starred specimen\.|\bready\b|\bclip\b/i);
	await ui.dialogs.pick(/^Original transcript$/i);
	await ui.dialogs.expect(/Starred specimen\./);
	ui.dialogs.input("\x1b");
	await ui.dialogs.pick(/^\s*(?:star|protect)(?:\s|$)/i);
	await until(async () => (await readRows()).some((row) => row.id === star.id && row.starred), "star action did not protect the exact row");
	await leave(ui, pending);
	// Seed an imported, ready row via L's verified copy boundary, not an INSERT or
	// a fake WAV. The registered import dialog/media journey is exercised by V5.
	const { enqueueImport, publishAudio, updateTake } = await library();
	const signal = new AbortController().signal;
	const bytes = wav(Buffer.alloc(fullInput.length, 33));
	const audio = { bytes: bytes.length, sha256: sha(bytes), async copyTo(target) {
		const fd = target.createPrivateFile("import-seed.wav");
		try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
		return target.liveFilePath("import-seed.wav");
	} };
	const id = await enqueueImport(f.sample, { variantId: f.model, compute: "auto", requestedDeviceId: null, language: "fr", task: "transcribe", detector: "model", chunking: true }, signal);
	await publishAudio(id, audio, signal);
	await updateTake(id, { raw: "Imported specimen.", local: "Imported specimen.", state: "ready" }, signal);
	const rows = await readRows();
	const imported = rows.find((row) => row.id === id);
	assert.equal(imported?.source, "import");
	assert.equal(imported?.wav?.sha256, audio.sha256);
	return [rows.find((row) => row.id === star.id), imported];
}

async function editRetention(ui, policy, approve) {
	// A proposed config value is not active retention until the visible preview is explicitly confirmed.
	await writeMicmeConfigValues({ MICME_RETENTION: policy });
	const { pending } = await ui.open("history");
	await ui.dialogs.pick(/^Retention…$/i);
	await ui.dialogs.pick(new RegExp(`^Preview configured policy \\(${policy}\\)$`, "i"));
	await ui.dialogs.expect(new RegExp(`Apply retention: ${policy}\\?`, "i"));
	await ui.dialogs.pick(approve ? /^Apply retention$/i : /^Cancel$/i);
	if (approve) await ui.dialogs.expect(/Retention applied/i);
	await leave(ui, pending);
}

test("Pi restart plays and retries the exact saved ASR-failed WAV but rejects a same-size replacement", posix, async (t) => {
	const f = await isolatedJourney(t, { MICME_HISTORY: "1" });
	const first = await f.host({ width: 80 });
	await take(f, first, { failAsr: true });
	assertUntouched(first);
	const saved = await savedWav(f, "opted-in ASR failure did not retain verified audio");
	const [failed] = await readRows();
	assert.equal(failed.state, "asr-failed");
	assert.equal(failed.wav.sha256, saved.digest);
	assert.equal(failed.local, null);
	await first.close();

	const ui = await f.host({ width: 40 });
	await f.control({ text: "Recovered public words." });
	const { pending } = await rowDetail(ui, /ASR[- ]failed|recognition failed|transcription failed/i);
	await ui.dialogs.pick(/^\s*play(?:\s|$)/i);
	const played = await f.waitEvent("play", 1, ui.diagnostics);
	assert.deepEqual(played, { kind: "play", digest: saved.digest, bytes: saved.bytes });
	await ui.dialogs.pick(/^Retry with current model/i);
	await ui.dialogs.pick(/^Start retry$/i);
	await until(async () => (await readRows()).some((row) => row.id === failed.id && row.local === "Recovered public words." && row.state === "ready"), "retry did not update the same row");
	const clips = await f.events("clip");
	assert.equal(clips.length, 2, "ASR should be called once before and once after restart");
	assert.equal(clips[1].digest, saved.digest);
	assertUntouched(ui);
	await leave(ui, pending);
	await ui.close();

	await rename(saved.path, `${saved.path}.fixture-original`);
	const replacement = wav(Buffer.alloc(fullInput.length, 95));
	await writeFile(saved.path, replacement);
	const reopened = await f.host({ width: 80 });
	const detail = await rowDetail(reopened, /Recovered public words\.|\bready\b|\bclip\b/i);
	await reopened.dialogs.expect(/No verified saved audio/i);
	assert.doesNotMatch(reopened.dialogs.text(), /^\s*[→❯›>]?\s*(?:Play saved audio|Retry with current model)/im, "unsafe WAV got an enabled play/retry action");
	const { verifiedAudio, play, retry } = await library();
	const signal = new AbortController().signal;
	assert.equal(await verifiedAudio(failed.id, signal), null);
	await Promise.allSettled([play(failed.id, 0, signal), retry(failed.id, { variantId: f.model, compute: "auto", requestedDeviceId: null, language: "fr", task: "transcribe", detector: "model", chunking: true }, signal)]);
	assert.deepEqual(await readFile(saved.path), replacement, "unverified replacement was removed or overwritten");
	assert.equal((await f.events("play")).length, 1);
	assert.equal((await f.events("clip")).length, 2);
	assertUntouched(reopened);
	await leave(reopened, detail.pending);
});

test("Pi keeps copyable failed-delivery text distinct from ASR failure", posix, async (t) => {
	const f = await isolatedJourney(t, { MICME_HISTORY: "1" });
	const first = await f.host();
	first.failEditor();
	await take(f, first);
	await savedWav(f, "failed delivery lost the completed local result");
	const [row] = await readRows();
	assert.equal(row.state, "delivery-failed");
	assert.equal(row.raw, publicText);
	assert.equal(row.local, publicText);
	assertUntouched(first);
	await first.close();

	const ui = await f.host();
	const { pending } = await rowDetail(ui, /delivery[- ]failed|could not deliver/i);
	await ui.dialogs.expect(/Saved text is still copyable/i);
	await ui.dialogs.pick(/^Original transcript$/i);
	await ui.dialogs.expect(/Public specimen words\./);
	await ui.dialogs.expect(/copy|selectable text/i);
	await leave(ui, pending);
});

test("Pi warns once if the opt-in history save fails and never publishes a retryable WAV", posix, async (t) => {
	const f = await isolatedJourney(t, { MICME_HISTORY: "1" });
	const ui = await f.host();
	await take(f, ui);
	const existing = await savedWav(f, "could not prime the opted-in library for a save failure");
	const audioDir = dirname(existing.path);
	assert.notEqual(audioDir, f.agent, "library WAVs must have a private directory under the agent dir");
	const parked = `${audioDir}.before`;
	await rename(audioDir, parked);
	await writeFile(audioDir, "fixture obstruction; not a directory");
	await take(f, ui, { text: "Public unsaved words." });
	assert.equal(ui.text, `${prompt}${publicText} Public unsaved words. `, "a failed history save blocked ordinary review");
	assert.equal(ui.notices.filter(({ message }) => /(?:could not|unable|failed)[^\n]*(?:save|history)|(?:save|history)[^\n]*(?:failed|unavailable)/i.test(message)).length, 1);
	assert.equal((await files(parked, ".wav")).length, 1, "failed save published audio through an old location");
	assert.deepEqual(await files(f.spool, ".wav"), [], "unsaved audio survived as a playback/retry candidate");
	await rm(audioDir);
	await rename(parked, audioDir);
	assert.ok((await readRows()).every((row) => row.wav === null || row.raw === publicText));
	assert.deepEqual(ui.sends, []);
});

test("Pi applies approved count:1 to two later saves and restart without pruning starred or imported WAVs", posix, async (t) => {
	const f = await isolatedJourney(t, { MICME_HISTORY: "1", MICME_RETENTION: "count:1" });
	t.mock.timers.enable({ apis: ["Date"], now: jan });
	const ui = await f.host();
	const protectedRows = await flagProtected(f, ui);
	t.mock.timers.setTime(jan + 1);
	const older = await namedTake(f, ui, "Older eligible specimen.", 33);
	t.mock.timers.setTime(jan + 2);
	const recent = await namedTake(f, ui, "Recent eligible specimen.", 34);
	await checkInventory(f, [...protectedRows, older, recent]); // Merely proposed, no consent.
	await editRetention(ui, "count:1", true);
	await checkInventory(f, [...protectedRows, recent]);
	t.mock.timers.setTime(jan + 3);
	const first = await namedTake(f, ui, "First subsequent save.", 35);
	await checkInventory(f, [...protectedRows, first]);
	t.mock.timers.setTime(jan + 4);
	const latest = await namedTake(f, ui, "Second subsequent save.", 36);
	await checkInventory(f, [...protectedRows, latest]);
	await ui.close();
	checkColdInventory(await coldLibraryRestart(f, jan + 5), [...protectedRows, latest]);
	const restarted = await f.host({ width: 40 });
	const history = await restarted.open("history");
	const surviving = await checkInventory(f, [...protectedRows, latest]);
	assert.equal(surviving.find(({ id }) => id === protectedRows[0].id).starred, true);
	assert.equal(surviving.find(({ id }) => id === protectedRows[1].id).source, "import");
	assertUntouched(restarted);
	await leave(restarted, history.pending);
});

test("Pi preserves a confirmed UTC age policy after a canceled edit, but only enforces it on opted-in restarts", posix, async (t) => {
	const f = await isolatedJourney(t, { MICME_HISTORY: "1" });
	t.mock.timers.enable({ apis: ["Date"], now: jan });
	const ui = await f.host();
	const protectedRows = await flagProtected(f, ui);
	const old = await namedTake(f, ui, "Will expire before next save.", 38);
	t.mock.timers.setTime(jan + day);
	await editRetention(ui, "days:3", true); // No rows due yet; confirmation still activates it.
	await editRetention(ui, "count:0", false);
	await checkInventory(f, [...protectedRows, old]);
	t.mock.timers.setTime(jan + day * 5);
	const next = await namedTake(f, ui, "Will expire while Pi is closed.", 39);
	await checkInventory(f, [...protectedRows, next]);
	await ui.close();
	const restartTime = jan + day * 10;
	t.mock.timers.setTime(restartTime);
	await writeMicmeConfigValues({ MICME_HISTORY: "0" });
	const before = await f.audio();
	const { beforeListing } = await coldLibraryRestart(f, restartTime, { list: false });
	assert.deepEqual(beforeListing, before, "history-off startup pruned the existing library without consent");
	await writeMicmeConfigValues({ MICME_HISTORY: "1" });
	// Read the directory before page() in a fresh process. A list-time prune
	// must not hide missing enforcement at enabled session_start.
	checkColdInventory(await coldLibraryRestart(f, restartTime), protectedRows);
});
