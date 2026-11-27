import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeMicmeConfigValues } from "../src/config.ts";
import { files, fixtureInput, fullInput, middle, publicText, sha, tail, voiced, wav, zeros } from "./transfer-journey-fixtures.mjs";
import { assertUntouched, isolatedJourney, openAiKey, prompt, readyCue, take, until } from "./transfer-journey-harness.mjs";
import { leave, readRows } from "./transfer-journey-library.mjs";

// V4 is a deterministic Pi contract, not V3 native qualification. See live-native/README.md
// for the optional real-engine invocations. No fixture events here are B timing or WER evidence.
const posix = { skip: process.platform === "win32" && "requires POSIX recorder fixtures" };
const startingLive = { MICME_TRANSCRIPTION_MODE: "stream", MICME_STREAM_FINALIZE_WITH_CLIP: "1" };
const edited = "Operator edited, never send this automatically.";
const trialText = "Public words from the trial.";

async function stopCloseOnly(f, ui) {
	await rm(f.hookReady, { force: true });
	await ui.command();
	await until(() => access(f.hookReady).then(() => true, () => false), "the close-only recorder never installed its SIGINT handler", ui.diagnostics);
	const beforeStop = ui.visible();
	assert.deepEqual(await files(f.spool, ".wav"), [], "close-only fixture unexpectedly wrote before SIGINT");
	await ui.command();
	return beforeStop;
}

async function idle(ui) {
	await until(() => ui.statuses.length > 0 && !ui.statuses.at(-1) && [...ui.widgets.values()].every((value) => !value), "recording never settled to idle", ui.diagnostics);
}

test("Pi accepts two exact SIGINT/255 close-only clips, never claims samples early, and leaves history off", posix, async (t) => {
	const f = await isolatedJourney(t);
	await f.configure({ MICME_RECORD_COMMAND: f.closeOnly });
	const ui = await f.host({ width: 40 });
	assert.deepEqual(await f.events(), [], "opening Pi started a recorder or recognizer");
	const first = await stopCloseOnly(f, ui);
	await f.control({ text: "Second public specimen." });
	const second = await stopCloseOnly(f, ui);
	assert.deepEqual(ui.mutations, [{ paste: `${publicText} ` }, { paste: "Second public specimen. " }]);
	assert.equal(ui.text, `${prompt}${publicText} Second public specimen. `);
	assert.deepEqual(ui.sends, []);
	const calls = await f.events("clip");
	assert.equal(calls.length, 2);
	assert.ok(calls.every(({ digest }) => digest === sha(wav(Buffer.alloc(1_024, 32)))));
	ui.edit(edited);
	await ui.command("last");
	assert.equal(ui.text, `${edited}Second public specimen. `);
	assert.deepEqual(await files(f.agent), [f.configPath], "history-off created a persistent store or WAV");
	assert.deepEqual(f.network, []);
	for (const beforeStop of [first, second]) {
		assert.doesNotMatch(beforeStop, readyCue);
		assert.match(beforeStop, /opaque|recorder running|custom (?:hook|recorder)|cannot (?:observe|verify)|samples unknown/i);
	}
});

for (const mode of ["sample", "mic"]) {
	test(`Pi setup runs a review-only installed Whisper ${mode} before P4 with auto-submit on`, posix, async (t) => {
		const f = await isolatedJourney(t);
		await f.configure({ MICME_RECORD_COMMAND: f.closeOnly });
		if (mode === "mic") await rm(f.sample);
		const ui = await f.host({ width: mode === "sample" ? 80 : 40, busy: mode === "mic" });
		// Establish ordinary replay first; Try It must not replace this slot.
		await stopCloseOnly(f, ui);
		await f.reset();
		await writeMicmeConfigValues({ MICME_AUTO_SUBMIT: "1", MICME_TRANSLATE_TO_ENGLISH: "fr" });
		await f.control({ text: trialText });
		ui.edit(edited);
		const before = ui.mutations.length;
		let stop;
		ui.requireAction("setup");
		const { pending } = await ui.open("setup");
		await ui.dialogs.pick(mode === "sample" ? /^Try It: local sample\b/i : /^Try It: microphone\b/i);
		if (mode === "sample") {
			await ui.dialogs.type(/Local sample WAV path/i, f.sample);
			assert.deepEqual(await f.events("clip"), [], "sample was processed before explicit consent");
			await ui.dialogs.pick(/^Transcribe sample\b/i);
		} else {
			assert.deepEqual(await f.events("clip"), [], "mic trial processed audio before consent");
			await assert.rejects(access(f.hookReady), { code: "ENOENT" });
			await ui.dialogs.expect(/Try microphone\?/i);
			await ui.dialogs.pick(/^Start recording\b/i);
			await until(() => access(f.hookReady).then(() => true, () => false), "confirmed mic trial never reached the real stop hook", ui.diagnostics);
			await until(() => /Recorder running; stop to finish/i.test(ui.visible()), "the host never exposed the ordinary stop toggle for the trial", ui.diagnostics);
			assert.deepEqual(await files(f.spool, ".wav"), []);
			stop = ui.command(); // Stop opens a review that must be dismissed before the command completes.
		}
		await until(() => ui.visible().includes(trialText), "transcript never reached a separate Pi review view", ui.diagnostics);
		assert.match(ui.visible(), /\breview\b/i);
		assertUntouched(ui, edited, before);
		assert.deepEqual(await f.events("modelLoaded"), [], "review unexpectedly required Worker v1/P4");
		assert.deepEqual(await f.events("trigger"), [], "Try It unexpectedly opened the built-in recorder");
		const input = mode === "sample" ? wav(fullInput) : wav(Buffer.alloc(1_024, 32));
		assert.deepEqual(await f.events("clip"), [{ kind: "clip", model: f.model, language: "fr", translate: true,
			digest: sha(input), pcmSha256: sha(input.subarray(44)), bytes: input.length }]);
		if (mode === "sample") await assert.rejects(access(f.hookReady), { code: "ENOENT" });
		await leave(ui, pending);
		await stop;
		await writeMicmeConfigValues({ MICME_AUTO_SUBMIT: "0" });
		await ui.command("last");
		assert.equal(ui.text, `${edited}${publicText} `, "review overwrote ordinary Pi replay");
		assert.deepEqual(ui.sends, []);
		assert.deepEqual(await files(f.agent), [f.configPath]);
		assert.deepEqual(f.network, []);
	});
}

test("Pi setup/diagnostic preview is inert, diagnoses a missing model, and reuses an offline repair", posix, async (t) => {
	const f = await isolatedJourney(t, { MICME_POLISH_PROMPT: "PUBLIC_PRIVATE_PROMPT_CANARY", MICME_POLISH_KEY_ENV: "MICME_FIXTURE_KEY", MICME_WHISPER_STREAM_BIN: "/old/sdl-unchanged" });
	const ui = await f.host({ width: 80 });
	const transcriptCanary = "PUBLIC_DIAGNOSTIC_TRANSCRIPT_CANARY";
	await take(f, ui, { text: transcriptCanary });
	assert.ok(ui.text.includes(transcriptCanary));
	ui.edit(prompt);
	const diagnosticStart = ui.notices.length;
	const experimental = /^\s*[→❯›>]?\s*(?:Vulkan|Silero|local LID|output hook)\s*(?:[:(]|$)/im;
	const prefs = await ui.open("conf", /settings|configuration|transcription/i);
	const freshPrefs = ui.dialogs.text();
	assert.doesNotMatch(freshPrefs, experimental, "unqualified advanced controls shown on fresh settings");
	await leave(ui, prefs.pending);
	await f.reset();
	await f.control({});
	await rename(f.model, `${f.model}.offline`);
	await chmod(f.configPath, 0o640);
	const original = await readFile(f.configPath);
	const { pending } = await ui.open("setup");
	await until(() => /missing|not installed|repair/i.test(ui.visible()), "setup did not show a repair for the missing installed model", ui.diagnostics);
	const fresh = ui.dialogs.text();
	assert.match(ui.visible(), /whisper|model|weights/i);
	assert.doesNotMatch(fresh, experimental, "unqualified advanced controls shown on first setup");
	const diagnostics = `${freshPrefs}\n${fresh}\n${JSON.stringify(ui.notices.slice(diagnosticStart))}`;
	for (const canary of [openAiKey, "PUBLIC_PRIVATE_PROMPT_CANARY", transcriptCanary]) assert.ok(!diagnostics.includes(canary), "diagnostics exposed a private value");
	await leave(ui, pending);
	assert.deepEqual(await readFile(f.configPath), original);
	assert.equal((await stat(f.configPath)).mode & 0o777, 0o640, "preview changed consent/config permissions");
	assert.deepEqual(await f.events(), []);
	assert.deepEqual(f.network, []);
	await rename(`${f.model}.offline`, f.model);
	const repaired = await ui.open("setup", /installed|reuse|local|ready/i);
	assert.doesNotMatch(ui.dialogs.text(), /(?:weights|model) (?:is )?missing/i);
	await leave(ui, repaired.pending);
	await take(f, ui);
	assert.deepEqual((await f.events("clip")).map(({ model }) => model), [f.model]);
	assert.equal(ui.text, `${prompt}${publicText} `);
	assert.deepEqual(f.network, []);
});

test("Pi history explains its opt-in without opening a store or mutating the editor", posix, async (t) => {
	const f = await isolatedJourney(t);
	const ui = await f.host();
	ui.requireAction("history");
	const pending = ui.command("history");
	await until(() => /history[\s\S]*\b(?:off|disabled|opt[- ]in|enable)\b|enable (?:local )?history/i.test(ui.visible()), "history-off did not explain opt-in", ui.diagnostics);
	await leave(ui, pending);
	assert.deepEqual(await files(f.agent), [f.configPath]);
	assert.deepEqual(await f.events(), []);
	assertUntouched(ui);
});

test("Pi waits for a header and real zero samples, latches one milestone before feed, and never invents speech", posix, async (t) => {
	const f = await isolatedJourney(t, { ...startingLive, MICME_STREAM_FINALIZE_WITH_CLIP: "0" });
	const ui = await f.host({ width: 40 });
	for (const allZero of [true, false]) {
		await f.reset();
		await f.control({ gated: true, pcm: "zero", allZero, noSpeech: true, followup: !allZero });
		const start = ui.command();
		await f.waitEvent("trigger");
		assert.doesNotMatch(ui.visible(), readyCue);
		await f.gate("header");
		await f.waitEvent("header");
		await until(() => /wait(?:ing)?[^\n]*(?:sample|PCM)/i.test(ui.visible()), "Pi never showed waiting for real samples", ui.diagnostics);
		assert.deepEqual(await f.events("feed"), [], "header/empty poll advanced the cursor");
		assert.deepEqual(await f.events("readyCue"), [], "header/empty poll signaled ready");
		await f.gate("block");
		await start;
		await f.waitEvent("feed");
		if (!allZero) {
			await f.gate("followup");
			await f.waitEvent("feed", 2);
			assert.doesNotMatch(ui.visible(), /speech detected|speech confirmed|hearing speech/i, "a nonzero amplitude was mistaken for speech");
		}
		await ui.command();
		const trace = await f.events();
		assert.equal(trace.filter(({ kind }) => kind === "readyCue").length, 1, JSON.stringify(trace));
		assert.ok(trace.findIndex(({ kind }) => kind === "readyCue") < trace.findIndex(({ kind }) => kind === "feed"), "Pi signaled first samples only after the worker got them");
		const blocks = allZero ? [zeros, Buffer.alloc(tail.length)] : [zeros, middle, tail];
		let through = 0;
		const expectedFeeds = blocks.map((pcm) => {
			const from = through;
			through += pcm.length / 2;
			return { kind: "feed", from, through, pcmSha256: sha(pcm) };
		});
		assert.deepEqual(await f.events("feed"), expectedFeeds);
		assert.deepEqual((await f.events("ack")).map(({ through: ack }) => ack), expectedFeeds.map(({ through: boundary }) => boundary));
		assert.deepEqual(await f.events("done"), [{ kind: "done", through, asrCalls: 0 }]);
		assert.match(ui.visible(), /no (?:speech|words)|did not recogni[sz]e|non[- ]speech/i);
		assert.deepEqual(await f.events("clip"), []);
		assertUntouched(ui);
	}
});

test("Pi distinguishes device loss from decoder failure and reconnects with the requested input and language task", posix, async (t) => {
	const f = await isolatedJourney(t, { ...startingLive, MICME_STREAM_FINALIZE_WITH_CLIP: "0" });
	const ui = await f.host();
	await f.control({ gated: true });
	const start = ui.command();
	const recorder = await f.waitEvent("trigger");
	assert.equal(recorder.input, fixtureInput);
	await f.gate("unplug");
	await start;
	await idle(ui);
	assert.match(ui.visible(), /disconnect|device (?:failed|lost)|no such input/i);
	assert.deepEqual(await f.events("readyCue"), [], "a disconnected device produced a stale readiness cue");
	assert.deepEqual(await f.events("feed"), []);
	assert.deepEqual(await f.events("clip"), []);
	assertUntouched(ui);
	await f.reset();
	const other = process.platform === "darwin" ? ":3" : "other-mic";
	const deviceKey = process.platform === "darwin" ? "MICME_AVFOUNDATION_INPUT" : "MICME_PULSE_SOURCE";
	await writeMicmeConfigValues({ [deviceKey]: other, MICME_TRANSCRIPTION_MODE: "clip", MICME_LANGUAGE: "de", MICME_TRANSLATE_TO_ENGLISH: "de" });
	await take(f, ui);
	assert.equal((await f.events("trigger"))[0].input, other);
	assert.deepEqual((await f.events("clip")).map(({ language, translate, pcmSha256 }) => ({ language, translate, pcmSha256 })), [{ language: "de", translate: true, pcmSha256: sha(fullInput) }]);
	assert.equal(ui.text, `${prompt}${publicText} `);
	assert.deepEqual(ui.sends, []);
	assert.deepEqual(f.network, []);
});

for (const outcome of ["recover", "replace", "prefix", "cancel"]) {
	test(`Pi ${outcome === "recover" ? "recovers the stopped full WAV" : `rejects ${outcome}`} after a read-but-unacknowledged live prefix`, posix, async (t) => {
		const f = await isolatedJourney(t, { ...startingLive, MICME_HISTORY: "1" });
		const ui = await f.host();
		await f.control({ worker: "no-ack", damage: ["replace", "prefix"].includes(outcome) ? outcome : undefined });
		await ui.command();
		const feed = await f.waitEvent("feed");
		assert.deepEqual(feed, { kind: "feed", from: 0, through: voiced.length / 2, pcmSha256: sha(voiced) });
		assert.deepEqual(await f.events("ack"), []);
		ui.edit(edited);
		if (outcome === "cancel") {
			ui.requireAction("cancel");
			await ui.command("cancel");
		} else {
			const { pid } = await f.waitEvent("modelLoaded");
			process.kill(pid, "SIGKILL");
		}
		if (outcome !== "cancel") await f.waitEvent("drained");
		await idle(ui);
		assert.deepEqual(await f.events("finish"), [], "ordinary refinement finished with missing worker ACK");
		assert.deepEqual(await f.events("done"), []);
		assertUntouched(ui, edited);
		const clips = await f.events("clip");
		const saved = await f.audio();
		if (outcome === "recover") {
			assert.ok(clips.length <= 1, "unexpected repeat recovery");
			assert.ok(saved.length === 1 || clips.length === 1, "worker loss produced no verified same-take recovery input");
			for (const input of [...clips, ...saved]) {
				assert.equal(input.bytes, wav(fullInput).length, "recovery lost the recorder's stop-time tail");
				assert.equal(input.digest, sha(wav(fullInput)), "retry did not consume the exact same take");
			}
		} else {
			assert.deepEqual(clips, [], "retry consumed changed, replaced, or canceled audio");
			assert.deepEqual(saved, [], "unsafe audio published as a library WAV");
			if (outcome === "cancel") assert.deepEqual(await readRows(), [], "cancel published a history row");
			else assert.ok((await readRows()).every((row) => row.wav === null), "unsafe audio made a retryable row");
		}
		// No stale input, old final or dead worker may carry over to a new take.
		await f.reset();
		await f.control({ text: "Clean subsequent take." });
		await ui.command();
		await f.waitEvent("ack");
		await ui.command();
		assert.equal((await f.events("feed"))[0].from, 0);
		assert.match(ui.text, /Clean subsequent take\./);
		assert.equal(ui.text.split("Clean subsequent take.").length, 2);
		assert.ok(ui.text.startsWith(edited));
		assert.doesNotMatch(ui.text, /unacknowledged span|Stale result after cancel/);
		assert.deepEqual(ui.sends, []);
	});
}

test("Pi cancel during failed-worker drain discards the valid tail and leaves replay untouched", posix, async (t) => {
	const f = await isolatedJourney(t, { ...startingLive, MICME_HISTORY: "1" });
	const ui = await f.host();
	await f.control({ worker: "no-ack", holdDrain: true });
	await ui.command();
	await f.waitEvent("feed");
	assert.deepEqual(await f.events("ack"), []);
	ui.edit(edited);
	const { pid } = await f.waitEvent("modelLoaded");
	process.kill(pid, "SIGKILL");
	await f.waitEvent("stopGesture", 1, ui.diagnostics);
	assert.deepEqual(await f.events("drained"), [], "recorder must still be holding the valid tail");
	assert.match(ui.statuses.at(-1), /stopping/i);
	const cancel = ui.command("cancel");
	try {
		await idle(ui);
	} finally {
		await f.gate("release-drain");
		await cancel;
	}
	const drained = await f.waitEvent("drained", 1, ui.diagnostics);
	assert.equal(drained.pcmSha256, sha(fullInput));
	assert.deepEqual(await f.events("clip"), [], "canceled take reached retry");
	assert.deepEqual(await readRows(), [], "canceled recovery published a history row");
	assert.deepEqual(await f.audio(), [], "canceled recovery published audio");
	await ui.command("last");
	assertUntouched(ui, edited);
});

test("Pi ordinary live refinement cannot treat a premature done as the missing ACK", posix, async (t) => {
	const f = await isolatedJourney(t, startingLive);
	const ui = await f.host();
	await f.control({ worker: "no-ack", damage: "prefix" });
	await ui.command();
	await f.waitEvent("feed");
	const stop = ui.command();
	await f.waitEvent("drained");
	await f.gate("bad-done");
	await stop;
	await f.waitEvent("premature-done");
	assert.deepEqual(await f.events("ack"), []);
	assert.deepEqual(await f.events("finish"), [], "host issued Worker v1 finish with unacknowledged input");
	assert.deepEqual(await f.events("clip"), [], "ordinary refinement trusted a synthetic ACK");
	assertUntouched(ui);
	assert.match(ui.visible(), /unexpected done|acknowledg|protocol/i);
});

test("Pi RPC refuses interactive actions and only explicitly replays a complete live final", posix, async (t) => {
	const f = await isolatedJourney(t, { ...startingLive, MICME_STREAM_FINALIZE_WITH_CLIP: "0" });
	const ui = await f.host({ mode: "rpc" });
	await ui.command();
	await f.waitEvent("ack");
	await ui.command();
	assertUntouched(ui);
	await ui.command("last");
	assert.equal(ui.text, `${publicText} `); // RPC's real paste semantics replace the write-only prompt.
	ui.edit(edited);
	const before = ui.mutations.length;
	for (const action of ["setup", "history", "import", "preview", "polish"]) {
		await ui.command(action);
		assert.match(ui.notices.at(-1)?.message ?? "", /interactive|TUI|not available in RPC/i, `/micme ${action} did not explicitly refuse RPC`);
	}
	assertUntouched(ui, edited, before);
	assert.equal(ui.dialogs.seen.length, 0);
	assert.equal((await f.events("trigger")).length, 1);
	assert.deepEqual(f.network, []);
});

test("Pi rejects an explicitly selected English-only Whisper clip weight before recording a French translation", posix, async (t) => {
	const f = await isolatedJourney(t);
	const english = join(dirname(f.model), "ggml-base.en.bin");
	await writeFile(english, "public fixture, not weights");
	await f.configure({ MICME_WHISPER_CPP_MODEL: english, MICME_TRANSLATE_TO_ENGLISH: "fr" });
	const ui = await f.host();
	await ui.command();
	assert.deepEqual(await f.events("trigger"), [], "incompatible explicit weights must be rejected before opening a recorder");
	assert.match(ui.visible(), /English.only|incompatible|does not support translation/i);
	assertUntouched(ui);
});

test("Pi verified model repair, loaded stream/batch routing, qualified device choices and conflict preflight", { skip: process.platform !== "linux" || process.arch !== "x64" }, async () => {
	const isolated = fileURLToPath(new URL("./transfer-journey-engine.mjs", import.meta.url));
	try {
		// Passing NODE_TEST_CONTEXT from the outer runner can suppress nested CLI
		// execution. Pass only the disposable scratch location, not the host env.
		const { stdout } = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=dot", isolated], { env: { TMPDIR: tmpdir() } });
		assert.match(stdout, /^\.{4}$/m, "did not execute the four isolated E/M cases");
	} catch (error) {
		assert.fail([error.stdout, error.stderr].filter(Boolean).join("\n") || error.message);
	}
});
