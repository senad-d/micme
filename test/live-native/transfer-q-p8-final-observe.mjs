// Public functional receipts for Pi's production preview binding; not a timing run.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { KEY, MODEL, OUTPUT, POLISHED, PROMPT, RAW, piFixture, receiver } from "../transfer-final-fixtures.mjs";
import { enterCommand, observedPi, waitFor } from "./transfer-pi-local.mjs";

const entry = new URL("../../src/extension.ts", import.meta.url).href;
const binary = fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url));
const layouts = [
	{ width: 40, auto: true, outcome: "success", toggle: "m", preview: "3" },
	{ width: 80, auto: true, outcome: "empty", toggle: "m", preview: "3" },
	{ width: 40, auto: true, outcome: "cancel", toggle: "m", preview: "3" },
	{ width: 80, auto: false, outcome: "fallback", toggle: "3", preview: "7" },
];

// Read back the actual composer and count API calls without forwarding sends.
// The only test shortcut is Alt+6 (readback). Pi dispatches the production
// shortcuts, with their original handlers, using the terminal bytes below.
function observedExtension(trace) {
	return `import micme from ${JSON.stringify(entry)};
import { appendFileSync } from 'node:fs';
const log = (kind, fields = {}) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ kind, ...fields }) + '\\n');
function observe(ctx) {
  const ui = new Proxy(ctx.ui, { get(target, key) {
    if (!['setEditorText', 'pasteToEditor', 'notify'].includes(key)) return target[key];
    return (text, level) => { log(key, { text, level }); return target[key](text, level); };
  } });
  return new Proxy(ctx, { get: (target, key) => key === 'ui' ? ui : target[key] });
}
export default function(pi) {
  pi.on('session_start', () => log('started'));
  pi.on('input', () => { log('blocked-input'); return { action: 'handled' }; });
  pi.registerShortcut('alt+6', { description: 'Evidence: read editor', handler: ctx => log('readback', { text: ctx.ui.getEditorText() }) });
  micme(new Proxy(pi, { get(target, key) {
    if (key === 'sendUserMessage') return (text, options) => log('send', { text, queued: options?.deliverAs === 'followUp' });
    if (key === 'registerShortcut') return (chord, spec) => target[key](chord, { ...spec, async handler(ctx) {
      try { return await spec.handler(observe(ctx)); }
      finally { log('shortcut-end', { chord }); }
    } });
    if (key === 'registerCommand') return (name, spec) => target[key](name, { ...spec, async handler(args, ctx) {
      try { return await spec.handler(args, observe(ctx)); }
      finally { log('command-end', { args }); }
    } });
    return target[key];
  } }));
}
`;
}

const editorEvents = new Set(["pasteToEditor", "setEditorText"]);
const flatten = (lines) => lines.map((line) => line.trim()).filter(Boolean).join(" ");
const warningsIn = (rows) => rows.filter(({ kind, level }) => kind === "notify" && level === "warning").map(({ text }) => text);

function candidateOnScreen(lines, expected) {
	const start = lines.findIndex((line) => line.includes("Micme preview · Read only"));
	const end = lines.findIndex((line, i) => i > start && line.includes("Esc / Enter close"));
	return start >= 0 && end > start && flatten(lines.slice(start + 1, end)).includes(expected);
}

function excerpt({ lines }, title, port) {
	const start = lines.findIndex((line) => line.includes(title));
	assert.notEqual(start, -1);
	const before = lines.slice(0, start).filter((line) => /Warning: Micme (?:polish|output hook):/u.test(line));
	const divider = lines.findIndex((line, i) => i > start && /^─{5}/u.test(line));
	const end = divider < 0 ? lines.length : lines.findIndex((line, i) => i > divider && /^─{5}/u.test(line));
	const body = lines.slice(start, end < 0 ? lines.length : end + 1);
	const hook = body.findIndex((line) => line.trimStart().startsWith("Trusted hook:"));
	if (hook >= 0) {
		const next = body.findIndex((line, i) => i > hook && line.trimStart().startsWith("The hook receives"));
		assert.ok(next > hook);
		body.splice(hook, next - hook, " Trusted hook: [isolated executable]");
	}
	return [...before, ...body].filter((line) => line.trim()).map((line) => line.replaceAll(`127.0.0.1:${port}`, "127.0.0.1:[port]"));
}

async function collect({ width, auto, outcome, toggle, preview }, signal) {
	const cleanups = [];
	const t = { signal, after: (cleanup) => cleanups.push(cleanup) };
	try {
		const other = outcome === "fallback" ? await receiver(t) : undefined;
		const provider = await receiver(t, other ? (res) => {
			res.writeHead(307, { location: new URL("unexpected", other.base).href });
			res.end();
		} : undefined);
		const f = await piFixture(t, { mode: "stream", auto, auth: true, selected: provider, origins: other ? [provider, other] : [provider] });
		f.state.env.MICME_SHORTCUT = `alt+${toggle}`;
		await f.scenario({ hook: { cancel: "hold", fallback: "error" }[outcome] ?? outcome });
		await writeFile(f.state.extension, observedExtension(f.trace));
		const pi = observedPi(f.state, binary, width, signal);
		const since = async (from) => (await f.read()).slice(from);
		const marked = (kind, from = 0, fields = {}) => waitFor(async () => (await since(from)).find((row) => row.kind === kind &&
			Object.entries(fields).every(([key, value]) => row[key] === value)), signal, `${outcome}: ${kind} ${JSON.stringify(fields)} missing`);
		const seen = (predicate, from, state) => waitFor(() => pi.frames.slice(from).find(({ lines }) => predicate(flatten(lines), lines)), signal, `${outcome}: ${state} missing`);
		const readback = async () => {
			const from = (await f.read()).length;
			pi.send("\x1b6");
			return (await marked("readback", from)).text;
		};
		try {
			await marked("started");
			let clipConsent;
			if (outcome === "success") {
				const shown = pi.frames.length, from = (await f.read()).length;
				enterCommand(pi, "/micme polish");
				clipConsent = await seen((text) => text.includes("Micme polish · New clip") && text.includes("Enter confirm"), shown, "clip consent");
				assert.match(flatten(clipConsent.lines), /Arm one clip/);
				pi.send("\x1b");
				await marked("command-end", from, { args: "polish" });
				assert.ok(!(await since(from)).some(({ kind }) => kind === "recorder-ready"));
				assert.equal(provider.calls.length, 0);
			}
			const existing = "PUBLIC EXISTING:";
			pi.send(existing);
			assert.equal(await readback(), existing);
			pi.send(`\x1b${toggle}`);
			const committed = `${existing} ${RAW} `;
			await marked("setEditorText", 0, { text: committed });
			pi.send("[during]");
			assert.equal(await readback(), `${committed}[during]`);
			// Legacy PTY input has no key-release event. Let Pi's repeat guard
			// expire before using the same production toggle to stop.
			await delay(1_050, undefined, { signal });
			const stopping = (await f.read()).length;
			pi.send(`\x1b${toggle}`);
			await marked("shortcut-end", stopping, { chord: `alt+${toggle}` });
			pi.send("[after]");
			const before = await readback();
			assert.equal(before, `${committed}[during][after]`);
			assert.equal(provider.calls.length, 0);
			assert.ok(!(await f.read()).some(({ kind }) => kind === "hook" || kind === "send"));
			pi.send("\x1b[D"); // Place the cursor inside the user edit, before ].

			const from = (await f.read()).length;
			const shown = pi.frames.length;
			const chord = `alt+${preview}`;
			pi.send(`\x1b${preview}`);
			const consent = await seen((text) => text.includes("Micme preview · Saved live final") && text.includes("Enter confirm"), shown, "consent");
			assert.match(flatten(consent.lines), /Polish \+ hook/);
			assert.match(flatten(consent.lines), /no audio or drafts/);
			assert.match(flatten(consent.lines), new RegExp(KEY));
			assert.ok(flatten(consent.lines).includes(MODEL) && flatten(consent.lines).includes(PROMPT));
			const beforeConfirm = { providerRequests: provider.calls.length, hookCalls: (await since(from)).filter(({ kind }) => kind === "hook").length };
			assert.deepEqual(beforeConfirm, { providerRequests: 0, hookCalls: 0 });
			pi.send("\r");
			const hook = await marked("hook", from);
			assert.equal(hook.text, outcome === "fallback" ? RAW : POLISHED);
			const expectedCandidate = outcome === "success" ? OUTPUT : outcome === "fallback" ? RAW : null;
			let candidate, pending;
			if (expectedCandidate) candidate = await seen((_text, lines) => candidateOnScreen(lines, expectedCandidate), shown, "candidate");
			if (outcome === "cancel") pending = await seen((text) => text.includes("Processing saved live final…"), shown, "pending review");
			if (outcome !== "empty") pi.send("\x1b");
			await marked("shortcut-end", from, { chord });
			const rows = await since(from);
			assert.equal(rows.filter(({ kind }) => kind === "hook").length, 1);
			const editorWritesDuringReview = rows.filter(({ kind }) => editorEvents.has(kind)).length;
			const sends = rows.filter(({ kind }) => kind === "send");
			assert.equal(editorWritesDuringReview, 0);
			assert.equal(sends.length, 0);
			assert.ok(!rows.some(({ kind }) => kind === "blocked-input"));
			if (!expectedCandidate) assert.ok(!pi.frames.slice(shown).some(({ lines }) => flatten(lines).includes("Micme preview · Read only")));
			if (outcome === "empty") assert.ok(rows.some(({ kind, text, level }) => kind === "notify" && level === "info" && text.includes("No preview was produced")));
			const warnings = warningsIn(rows);
			assert.deepEqual(warnings, outcome === "fallback" ? [
				"Micme polish: redirect blocked; using the original local transcript.",
				"Micme output hook: failed; using the text from before the hook.",
			] : []);
			if (other) assert.equal(other.calls.length, 0);
			const after = await readback();
			assert.equal(after, before);
			pi.send("!");
			const cursorProbe = await readback();
			assert.equal(cursorProbe, before.replace(/\]$/u, "!]"));

			const replayStart = (await f.read()).length;
			pi.send("\x05"); // Move to the end before clearing and explicitly replaying.
			enterCommand(pi, "/micme last");
			await marked("command-end", replayStart, { args: "last" });
			const replay = (await since(replayStart)).filter(({ kind }) => editorEvents.has(kind) || kind === "send");
			assert.deepEqual(replay, auto ? [{ kind: "send", text: RAW, queued: false }] : [{ kind: "pasteToEditor", text: `${RAW} ` }]);
			assert.equal(provider.calls.length, 1);
			const [{ method, path, data, headers }] = provider.calls;
			assert.equal(method, "POST");
			assert.equal(path, "/v6/chat/completions");
			assert.deepEqual(JSON.parse(data), {
				model: MODEL, messages: [{ role: "system", content: PROMPT }, { role: "user", content: RAW }], stream: false,
			});
			assert.ok(headers.authorization);
			const port = provider.base.port;
			return { outcome, width, autoSubmit: auto, recordingChord: `alt+${toggle}`, previewChord: chord, beforeConfirm,
				before, after, cursorProbe, candidate: expectedCandidate, hookInput: hook.text, warnings, replay,
				editorWritesDuringReview, sendAttemptsDuringReview: sends.length, queuedDuringReview: sends.filter(({ queued }) => queued).length,
				providerRequest: { method, path, body: JSON.parse(data), authenticated: Boolean(headers.authorization) },
				...(other && { redirectedRequests: other.calls.length }),
				...(clipConsent && { clipConsentFrame: excerpt(clipConsent, "Micme polish · New clip", port) }),
				consentFrame: excerpt(consent, "Micme preview · Saved live final", port),
				...(candidate && { candidateFrame: excerpt(candidate, "Micme preview · Read only", port) }),
				...(pending && { pendingFrame: excerpt(pending, "Micme preview", port) }) };
		} catch (error) {
			throw new Error(`${error.message}\n${pi.stderr()}\n${pi.frames.at(-1)?.lines.join("\n")}`, { cause: error });
		}
	} finally {
		for (const cleanup of cleanups.reverse()) await cleanup();
	}
}

for (const layout of layouts) console.log(JSON.stringify(await collect(layout, AbortSignal.timeout(30_000))));
