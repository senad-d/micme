import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { polish } from "../src/transfer/provider.ts";
import { processFinal } from "../src/transfer/process-final.ts";
import { traceRows } from "./live-native/transfer-pi-local.mjs";
import {
	KEY, MODEL, OUTPUT, POLISHED, PRIVATE_ERROR, PROMPT, RAW, SECRET,
	anthropic, executable, host, mutations, openAi, piFixture, receiver,
} from "./transfer-final-fixtures.mjs";

const FINAL = { raw: RAW, local: RAW, language: "en", source: "clip", rules: [] };
const REVIEW = { mode: "live-preview", row: null };
const PREPARED = { mode: "pending-clip", row: null, prepared: { text: POLISHED, polished: POLISHED, warning: "none" } };
const POSIX = { timeout: 20_000, skip: process.platform === "win32" && "requires a Unix executable hook" };
const PI = { timeout: 35_000, skip: process.platform !== "linux" && "requires the isolated Linux Pi launcher (Python and libseccomp)" };
const actualTimer = setTimeout;

function selection(provider, endpoint, { keyEnv = null, hook = null } = {}) {
	return { provider, endpoint, model: MODEL, prompt: PROMPT, keyEnv, hook };
}

function fixtureKey(t) {
	const previous = process.env[KEY];
	process.env[KEY] = SECRET;
	t.after(() => { if (previous === undefined) delete process.env[KEY]; else process.env[KEY] = previous; });
}

function checkRequest(call, family, { secret, text = RAW } = {}) {
	assert.equal(call.method, "POST");
	assert.match(call.headers["content-type"], /^application\/json\b/u);
	assert.equal(call.path, `/v6/${family === "messages" ? "messages" : "chat/completions"}`);
	const body = { model: MODEL, stream: false };
	if (family === "messages") {
		assert.equal(call.headers["anthropic-version"], "2023-06-01");
		assert.equal(call.headers["x-api-key"], secret);
		assert.equal(call.headers.authorization, undefined);
		Object.assign(body, { system: PROMPT, messages: [{ role: "user", content: text }], max_tokens: 1024 });
	} else {
		assert.equal(call.headers["x-api-key"], undefined);
		assert.equal(call.headers.authorization, secret ? `Bearer ${secret}` : undefined);
		body.messages = [{ role: "system", content: PROMPT }, { role: "user", content: text }];
	}
	assert.deepEqual(JSON.parse(call.data), body);
}

for (const { provider, family, success, invalid } of [
	{ provider: "custom-openai", family: "chat", success: openAi(), invalid: [openAi({ text: POLISHED }), openAi(" \n"), openAi(POLISHED, "length"),
		{ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "untrusted" }] } }] }] },
	{ provider: "custom-anthropic", family: "messages", success: anthropic(), invalid: [anthropic([{ type: "text", text: 27 }]),
		anthropic([{ type: "text", text: "  " }]), anthropic(undefined, "max_tokens"), anthropic([{ type: "tool_use", id: "untrusted" }], "tool_use")] },
]) {
	test(`V6 wire: ${family} sends one exact authenticated POST and accepts only completed nonblank text`, async (t) => {
		fixtureKey(t);
		const wire = await receiver(t);
		const c = selection(provider, wire.base, { keyEnv: KEY });
		const cases = [[200, JSON.stringify(success), "none"], ...invalid.map((body) => [200, JSON.stringify(body), "invalid"]),
			[200, `{bad-json: ${PRIVATE_ERROR}`, "invalid"], [401, PRIVATE_ERROR, "error"], [503, PRIVATE_ERROR, "error"]];
		for (const [i, [status, body, warning]] of cases.entries()) {
			wire.respond((res) => { res.writeHead(status); res.end(body); });
			assert.deepEqual(await polish(FINAL, c, t.signal), warning === "none"
				? { text: POLISHED, polished: POLISHED, warning }
				: { text: RAW, polished: null, warning }, `response ${i + 1} (${status}, ${warning})`);
			assert.equal(wire.calls.length, i + 1, "one request and no fallback retry");
			checkRequest(wire.calls[i], family, { secret: SECRET });
		}
	});
}

// Advance only the product deadline, after the receiver or child has taken
// input. Keep real socket and process-reaping timers running throughout.
function deadline(t, duration) {
	const controller = new AbortController();
	const original = AbortSignal.timeout;
	let expire;
	t.mock.method(AbortSignal, "timeout", (ms) => {
		if (ms !== duration) return original.call(AbortSignal, ms);
		expire = () => controller.abort(new DOMException("Fixture deadline", "TimeoutError"));
		return controller.signal;
	});
	t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
		const timer = actualTimer(fn, ms, ...args);
		if (ms === duration) expire = () => { clearTimeout(timer); fn.apply(timer, args); };
		return timer;
	});
	return () => {
		assert.equal(typeof expire, "function", `expected a ${duration} ms processing deadline`);
		expire();
	};
}

async function expectDispatch(observed, result, what) {
	await Promise.race([observed, result.then(() => assert.fail(`${what} settled without dispatch`))]);
}

for (const [provider, family] of [["local-openai", "chat"], ["custom-anthropic", "messages"]]) {
	test(`V6 wire: ${family} deadline keeps raw and cancellation discards a late final`, { timeout: 10_000 }, async (t) => {
		fixtureKey(t);
		const wire = await receiver(t, () => {});
		const c = selection(provider, wire.base, { keyEnv: family === "messages" ? KEY : null });
		const expire = deadline(t, 60_000);
		const entered = wire.next();
		const timeout = polish(FINAL, c, t.signal);
		await expectDispatch(entered, timeout, "polish");
		expire();
		assert.deepEqual(await timeout, { text: RAW, polished: null, warning: "timeout" });
		checkRequest(wire.calls[0], family, { secret: family === "messages" ? SECRET : undefined });
		t.mock.reset();

		let late;
		wire.respond((res) => { late = res; });
		const stop = new AbortController();
		const started = wire.next();
		const pending = processFinal({ ...FINAL, source: "live" }, REVIEW, c, AbortSignal.any([t.signal, stop.signal]));
		await expectDispatch(started, pending, "live final processing");
		stop.abort();
		late.end(JSON.stringify(family === "chat" ? openAi() : anthropic()));
		assert.deepEqual(await pending, { kind: "suppressed", reason: "cancel", warnings: [] });
		assert.equal(wire.calls.length, 2);
	});
}

async function observedHook(trace, signal) {
	while (!signal.aborted) {
		const hook = (await traceRows(trace)).find(({ kind }) => kind === "hook");
		if (hook) return hook;
		await new Promise((resolve) => actualTimer(resolve, 20));
	}
	signal.throwIfAborted();
}

for (const reason of ["timeout", "cancel"]) {
	test(`V6 pending processing: ${reason} terminates an input-consuming Unix hook`, POSIX, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "micme-v6-hook-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const control = join(root, "control.json");
		const trace = join(root, "hook.jsonl");
		await writeFile(control, '{"hook":"hold"}');
		const hook = await executable(root, "hook", { control, trace });
		const stop = new AbortController();
		const expire = reason === "timeout" ? deadline(t, 30_000) : () => stop.abort();
		const signal = AbortSignal.any([t.signal, stop.signal]);
		const pending = processFinal(FINAL, PREPARED, selection(null, null, { hook }), signal);
		const entered = observedHook(trace, signal);
		try {
			await expectDispatch(entered, pending, "Unix hook");
			const { text, pid } = await entered;
			assert.equal(text, POLISHED);
			expire();
			assert.deepEqual(await pending, reason === "timeout"
				? { kind: "candidate", text: POLISHED, warnings: [{ stage: "hook", reason: "timeout" }] }
				: { kind: "suppressed", reason: "cancel", warnings: [] });
			const state = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
			assert.ifError(state.error);
			// A killed orphan can remain visible as a zombie until PID 1 reaps it.
			assert.ok(state.status === 1 || (state.status === 0 && /^Z/u.test(state.stdout.trim())),
				`owner returned while its hook was still running: ${state.stdout.trim() || state.stderr}`);
		} finally { stop.abort(); await entered.catch(() => {}); }
	});
}

function warningRows(rows) {
	return rows.filter(({ kind, detail }) => kind === "notify" && ["error", "warning"].includes(detail)).map(({ text }) => text);
}

function noDisclosure(pi, rows) {
	const diagnostics = `${warningRows(rows).join("\n")}\n${pi.stderr()}`;
	for (const marker of [SECRET, PRIVATE_ERROR, RAW, "AX-019", "1,204.50"]) assert.ok(!diagnostics.includes(marker), "diagnostics disclosed protected fixture data");
}

async function processingConsent(pi, action) {
	const offset = pi.frames.length;
	pi.fire(action);
	const title = action === "polish" ? "Micme polish · New clip" : "Micme preview · Saved live final";
	return pi.until(() => pi.frames.slice(offset).find((frame) => frame.includes(title) && frame.includes("Enter confirm")), `${action} consent before processing`);
}

async function armClip(pi) {
	const count = (await pi.rows()).length;
	const consent = await processingConsent(pi, "polish");
	assert.match(consent, /Arm one clip/);
	assert.ok(!(await pi.rows()).slice(count).some(({ kind }) => kind === "recorder-ready"), "opening consent cannot start capture");
	pi.send("\r");
	await pi.mark("finished", { action: "polish" }, count);
	await pi.mark("recorder-ready", {}, count);
}

async function expectReplay(pi, auto, previous) {
	const begin = (await pi.rows()).length;
	await pi.run("last");
	const writes = mutations((await pi.rows()).slice(begin));
	assert.equal(writes.length, 1, "only explicit replay can deliver");
	assert.equal(writes[0].kind, auto ? "send" : "pasteToEditor");
	assert.equal(writes[0].text.trim(), RAW);
	if (!auto) assert.ok((await pi.run("inspect")).after.endsWith(`${RAW} `));
	if (previous !== undefined) assert.equal((await pi.run("inspect")).after.startsWith(previous), true);
}

for (const [provider, status, auth] of [["local-openai", 307, false], ["custom-openai", 308, true]]) {
	test(`V6 redirects: ${auth ? "authenticated" : "keyless"} ${status} leaves the selected origin only and warns with raw fallback`, PI, async (t) => {
		const other = await receiver(t);
		const selected = await receiver(t, (res) => {
			res.writeHead(status, { location: new URL("unexpected", other.base).href });
			res.end(PRIVATE_ERROR);
		});
		const f = await piFixture(t, { mode: "clip", selected, origins: [selected, other], provider, auth });
		await f.scenario({ hook: "passthrough" });
		const pi = await host(f);
		await pi.mark("ready");
		await armClip(pi);
		assert.equal(selected.calls.length, 0, "arming does not send before a final exists");
		await pi.run("toggle");
		const rows = await pi.rows();
		assert.equal(selected.calls.length, 1);
		checkRequest(selected.calls[0], "chat", { secret: auth ? SECRET : undefined });
		assert.deepEqual(other.calls, [], "redirect target received no request at all");
		assert.deepEqual(rows.filter(({ kind }) => kind === "hook").map(({ text }) => text), [RAW]);
		assert.deepEqual(mutations(rows), [{ kind: "pasteToEditor", text: `${RAW} ` }]);
		assert.equal(warningRows(rows).filter((message) => /polish.*redirect|redirect.*polish/iu.test(message)).length, 1, "a single visible polish/redirect warning");
		noDisclosure(pi, rows);
		await expectReplay(pi, false);
	});
}

async function store(f, operation = "inspect-library") {
	const probe = await host(f, "store", operation);
	const result = await probe.close;
	assert.equal(result.code, 0, probe.stderr());
	assert.deepEqual(await probe.rows(), [{ kind: "store", rows: [], wavs: [] }]);
}

test("V6 count:0: one completed real save/prune precedes the hook, one clip delivery, raw replay, empty enabled restart", PI, async (t) => {
	const selected = await receiver(t);
	const f = await piFixture(t, { mode: "clip", history: true, retention: "count:0", selected, origins: [selected] });
	await store(f, "confirm-count-zero"); // Confirmed policy, not just a configuration value.
	const pi = await host(f);
	await pi.mark("ready");
	await armClip(pi);
	assert.equal(selected.calls.length, 0);
	await pi.run("toggle");
	const rows = await pi.rows();
	const relevant = rows.filter(({ kind }) => ["save-start", "save-end", "hook", "pasteToEditor", "setEditorText", "send"].includes(kind));
	assert.deepEqual(relevant.map(({ kind }) => kind), ["save-start", "save-end", "hook", "pasteToEditor"]);
	const [save, saved, hook, paste] = relevant;
	assert.equal(save.final.raw, RAW);
	assert.equal(save.final.local, RAW);
	assert.equal(save.source, "clip");
	assert.equal(save.state, "ready");
	assert.equal(save.polished, POLISHED);
	assert.ok(save.bytes > 44, "verified WAV was supplied to the actual store");
	assert.equal(saved.row, null, "successful retention returns no surviving row");
	assert.equal(hook.text, POLISHED);
	assert.equal(paste.text, `${OUTPUT} `);
	assert.equal((await pi.run("inspect")).after, `${OUTPUT} `);
	assert.equal(selected.calls.length, 1, "no second polish after saving");
	checkRequest(selected.calls[0], "chat");
	assert.deepEqual(warningRows(rows).filter((message) => /history|library|storage|row|sav(?:e|ing)|retention/iu.test(message)), []);
	noDisclosure(pi, rows);
	await expectReplay(pi, false);
	await store(f);
	pi.send("\x15/quit\r");
	assert.equal((await pi.close).code, 0, pi.stderr());
	const restarted = await host(f);
	await restarted.mark("ready");
	await store(f);
	assert.equal(selected.calls.length, 1, "enabled restart never dispatches processing");
});

test("V6 pending clip: ordinary ASR does not process; empty/cancel suppress, and failed hook warns and falls back once", PI, async (t) => {
	const selected = await receiver(t);
	const f = await piFixture(t, { mode: "clip", selected, origins: [selected] });
	const pi = await host(f);
	await pi.mark("ready");
	await pi.run("toggle");
	await pi.mark("recorder-ready");
	assert.equal((await pi.run("toggle")).after, `${RAW} `, "ordinary clip actually completed and delivered");
	assert.equal(selected.calls.length, 0);
	assert.ok(!(await pi.rows()).some(({ kind }) => kind === "hook"));
	for (const hook of ["empty", "error"]) {
		const begin = (await pi.rows()).length;
		await f.scenario({ hook });
		await armClip(pi);
		const result = await pi.run("toggle");
		const done = (await pi.rows()).slice(begin);
		assert.deepEqual(done.filter(({ kind }) => kind === "hook").map(({ text }) => text), [POLISHED]);
		assert.deepEqual(mutations(done), hook === "empty" ? [] : [{ kind: "pasteToEditor", text: `${POLISHED} ` }]);
		assert.equal(result.after, hook === "empty" ? result.before : result.before + POLISHED + " ");
		assert.equal(warningRows(done).filter((text) => /hook/iu.test(text)).length, hook === "empty" ? 0 : 1);
		noDisclosure(pi, done);
	}
	assert.equal(selected.calls.length, 2);
	const begin = (await pi.rows()).length;
	await armClip(pi);
	let late;
	selected.respond((res) => { late = res; });
	const entered = selected.next();
	const stopping = pi.run("toggle");
	await expectDispatch(entered, stopping, "armed clip polish");
	const canceled = await pi.run("cancel");
	late.end(JSON.stringify(openAi()));
	await stopping;
	const done = (await pi.rows()).slice(begin);
	assert.equal(canceled.after, canceled.before);
	assert.deepEqual(mutations(done), []);
	assert.ok(!done.some(({ kind }) => kind === "hook"), "late response never reaches hook or editor");
	assert.equal(selected.calls.length, 3);
	noDisclosure(pi, done);
	await expectReplay(pi, false);
});

for (const auto of [false, true]) {
	test(`V6 edited live TUI: successful, empty and canceled previews never write or dispatch (auto-submit ${+auto})`, PI, async (t) => {
		const selected = await receiver(t);
		const f = await piFixture(t, { mode: "stream", auto, selected, origins: [selected] });
		const pi = await host(f);
		await pi.mark("ready");
		const prefix = "Existing prompt:";
		pi.send(prefix);
		assert.equal((await pi.run("inspect")).after, prefix);
		await pi.run("toggle");
		const committed = `${prefix} ${RAW} `;
		await pi.mark("setEditorText", { text: committed });
		const edit = "user addition";
		pi.send(edit);
		const edited = committed + edit;
		assert.equal((await pi.run("inspect")).after, edited);
		const stop = await pi.run("toggle");
		assert.equal(stop.after, edited, "ordinary stop preserves the user insertion");
		assert.equal(selected.calls.length, 0, "no provider on startup, commit or normal stop");
		assert.ok(!(await pi.rows()).some(({ kind }) => kind === "hook" || kind === "send"));

		for (const outcome of ["success", "empty", "cancel"]) {
			await f.scenario({ hook: outcome });
			const calls = selected.calls.length;
			const from = (await pi.rows()).length;
			const shown = pi.frames.length;
			const consent = await processingConsent(pi, "preview");
			assert.match(consent, /without changing the prompt or replay/);
			assert.equal(selected.calls.length, calls, "opening consent cannot send text");
			let late;
			const entered = outcome === "cancel" ? selected.next() : undefined;
			if (entered) selected.respond((res) => { late = res; });
			pi.send("\r");
			if (entered) {
				await expectDispatch(entered, pi.mark("finished", { action: "preview" }, from), "confirmed live preview");
				pi.send("\x1b");
			}
			const displayed = (text, rows) => pi.frames.slice(shown).some((frame) => frame.includes(text)) ||
				rows.some((row) => (row.kind === "editor" && row.detail?.includes(text)) || (row.kind === "notify" && row.text?.includes(text)));
			const settled = await pi.until(async () => {
				const rows = (await pi.rows()).slice(from);
				const ended = rows.find(({ kind, action }) => kind === "finished" && action === "preview");
				const emptyReview = outcome === "empty" && pi.frames.slice(shown).some((frame) => /(?:no|empty|suppressed) (?:.* )?(?:output|candidate)|nothing to copy/iu.test(frame));
				return (ended || displayed(OUTPUT, rows) || emptyReview) && { ended };
			}, `preview ${outcome} completed or showed a review candidate`);
			if (!settled.ended) pi.send("\x1b");
			const { before, after } = await pi.mark("finished", { action: "preview" }, from);
			late?.end(JSON.stringify(openAi()));
			assert.equal(before, edited);
			assert.equal(after, edited);
			const rows = (await pi.rows()).slice(from);
			assert.deepEqual(mutations(rows), []);
			if (outcome === "success") await pi.until(() => displayed(OUTPUT, rows), "transformed review rendered outside the prompt");
			else assert.ok(!displayed(OUTPUT, rows) && !displayed(POLISHED, rows), "empty/canceled preview produces no candidate");
			assert.equal(selected.calls.length - calls, 1);
			assert.deepEqual(rows.filter(({ kind }) => kind === "hook").map(({ text }) => text), outcome === "cancel" ? [] : [POLISHED]);
			checkRequest(selected.calls.at(-1), "chat");
			noDisclosure(pi, rows);
			await expectReplay(pi, auto, edited);
			if (!auto) {
				pi.send(`\x15${edited}`); // Restore only the explicit replay's append before the next preview.
				assert.equal((await pi.run("inspect")).after, edited);
			}
		}
	});
}

for (const auto of [false, true]) {
	test(`V6 real RPC: a live final is inert until explicit last (auto-submit ${+auto}; idle and busy)`, PI, async (t) => {
		const selected = await receiver(t);
		const f = await piFixture(t, { mode: "stream", auto, selected, origins: [selected] });
		const rpc = await host(f, "rpc");
		await rpc.mark("ready");
		const command = (action = "") => rpc.request("prompt", { message: `/micme ${action}`.trimEnd() });
		const editorWrites = () => rpc.rpc.filter(({ method }) => method === "set_editor_text");
		await command();
		await rpc.mark("worker-commit");
		await command();
		assert.deepEqual(editorWrites(), []);
		assert.deepEqual(mutations(await rpc.rows()), []);
		assert.equal(selected.calls.length, 0);
		assert.equal((await rpc.request("get_state")).isStreaming, false);

		// Exercise explicit replay both idle and while Pi's actual follow-up
		// queue is active. No provider credentials are used for the coding turn.
		await command("last");
		if (!auto) {
			assert.deepEqual(editorWrites().map(({ text }) => text), [`${RAW} `]);
			await rpc.request("prompt", { message: "Public coding turn held by the fixture" });
		}
		await rpc.mark("coding-model");
		assert.equal((await rpc.request("get_state")).isStreaming, true);
		await command("last");
		assert.equal((await rpc.request("get_state")).pendingMessageCount, auto ? 1 : 0);
		assert.deepEqual(editorWrites().map(({ text }) => text), auto ? [] : [`${RAW} `, `${RAW} `]);
		assert.deepEqual((await rpc.rows()).filter(({ kind }) => kind === "send"), auto
			? [{ kind: "send", text: RAW, queued: false }, { kind: "send", text: RAW, queued: true }] : []);
		if (auto) assert.ok(JSON.stringify(await rpc.mark("coding-model")).includes(RAW));
		await rpc.request("clear_queue");
		await rpc.request("abort");
		const delivered = mutations(await rpc.rows());
		await command("preview");
		assert.ok(rpc.rpc.some(({ method, message }) => method === "notify" && /interactive|requires .*TUI/iu.test(message)), "S preview refuses noninteractive RPC");
		assert.deepEqual(mutations(await rpc.rows()), delivered);
		assert.equal(selected.calls.length, 0);
		assert.ok(!(await rpc.rows()).some(({ kind }) => kind === "hook"));
	});
}
