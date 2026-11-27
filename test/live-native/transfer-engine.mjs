// Opt-in integrated P4 collector. Only disposable Pi state and hash-pinned public
// fixtures enter this driver; the old Whisper runner remains independent.
import { closeSync, createReadStream, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { arch, cpus, version } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getCatalogVariant } from "../../src/transfer/catalog.ts";
import { CONTINUOUS_KEYWORDS } from "./corpus.mjs";
import { readFixture } from "./transfer-fixtures.mjs";
import { piSourceSha256 } from "./transfer-pi.mjs";
import { alternateM, checkout, closePi, enterCommand, isolatedPi, observedPi, promptOnScreen, recorderCommand, startIsolated,
	traceRows, waitFor } from "./transfer-pi-local.mjs";
import { emptyTake, loadLocal, takeClock, withInterrupts } from "./transfer-runner.mjs";
import { scoreTake } from "./transfer-report.mjs";
import { readJson, validateProtocol, validateTake } from "./transfer-schema.mjs";
import { extraBoundaryRepeats, hasKeywords, tokens } from "./scoring.mjs";

const publicFixtures = new Set(["jfk", "continuous", "overload", "short", "quiet", "pause", "repeat", "silence", "noise", "immediate"]);
const negative = new Set(["silence", "noise", "immediate"]);
const engineSource = "transcribe-cpp-sys-0.4.2/275cd50d2c4104c204009a197ac091b9687668e5";
const uptime = () => Number(process.hrtime.bigint()) / 1e6;
const hash = (pcm) => createHash("sha256").update(pcm).digest("hex");

async function digest(path) {
	const sha = createHash("sha256");
	for await (const block of createReadStream(path)) sha.update(block);
	return sha.digest("hex");
}

function qualificationTrials(protocol, frozen, manifestSha256, variant, local) {
	const unique = new Map();
	for (const t of protocol.trials) {
		if (t.product !== "micme-current" || t.track !== "destination" || t.target !== "pi-prompt" || t.task !== "transcribe" ||
			t.language !== "en" || t.load !== "idle" || t.cache !== "cold-process" || t.processing !== "off" || !publicFixtures.has(t.fixture)) continue;
		const key = `${t.fixture}-${t.width}`;
		if (!frozen.trials.some((ref) => ref.product === t.product && ref.fixture === t.fixture && ref.track === t.track && ref.width === t.width &&
			ref.pcmSha256 === t.pcmSha256 && ref.referenceText === t.referenceText && ref.prefix === t.prefix)) throw new Error("Only frozen public PCM, references and prompt sentinels may be used for P4.");
		if (!unique.has(key)) unique.set(key, { ...t, pairId: `p4-${variant.id.split("/")[0]}-${manifestSha256.slice(0, 8)}-${key}`, repeatIndex: 0, input: "file",
			load: t.fixture === "overload" ? "contended" : t.load,
			rig: { os: version(), arch: arch(), display: "Pi isolated PTY", cpu: cpus()[0]?.model ?? null, gpu: null, driver: null,
				actualBackend: "unknown", actualDevice: null, requestedDevice: "cpu", threads: null, mic: "Paced public file; no real mic", hostVersion: null },
			build: { product: t.product, tag: null, commit: null, binarySha256: local?.recognizerSha256 ?? null, engineRevision: engineSource,
				backend: "micme-recognizer", modelRevision: variant.blobs[0].revision, modelFile: variant.blobs[0].path,
				modelSha256: variant.blobs[0].sha256, quant: variant.quant, vad: "off", chunkPolicy: "chunked: pause near 30s, hard bound 40s" } });
	}
	return [...unique.values()].sort((a, b) => (a.fixture === "jfk" ? -1 : b.fixture === "jfk" ? 1 : a.fixture.localeCompare(b.fixture) || a.width - b.width));
}

async function preflight(manifest, variant) {
	const local = await loadLocal(manifest);
	if (!local?.piBinary || !local.assetsDir || !local.recognizerFile || !local.recognizerSha256 || !local.workDir || !local.currentCheckout) {
		throw new Error("Supply the pinned recognizer, exact model, public fixtures, current checkout, isolated Pi binary and private work directory in transfer-local.json.");
	}
	if (await realpath(local.currentCheckout) !== await realpath(checkout)) throw new Error("Native P4 only activates the explicitly selected current checkout.");
	const blobs = local.engineModelFiles.filter((row) => row.variantId === variant.id);
	if (blobs.length !== 1 || blobs[0].blobPath !== variant.blobs[0].path || blobs[0].sha256 !== variant.blobs[0].sha256) throw new Error("Supply only the exact local model pin for this variant.");
	if (await digest(local.recognizerFile) !== local.recognizerSha256 || await digest(blobs[0].file) !== blobs[0].sha256) throw new Error("Recognizer or model bytes do not match their pins.");
	return { local, blob: blobs[0] };
}

function wrapper(trace) {
	return `import { appendFileSync, readFileSync } from 'node:fs';
import micme from ${JSON.stringify(join(checkout, "src/extension.ts"))};
import { observeRecognition, unload } from ${JSON.stringify(join(checkout, "src/transfer/recognition.ts"))};
const trace = ${JSON.stringify(trace)};
export default function(pi) {
 const remove = observeRecognition(event => {
   let rss = null;
   if (event.kind === 'released' && event.resident && event.pid) {
     try { const match = /^VmRSS:\\s+(\\d+)\\s+kB/m.exec(readFileSync('/proc/' + event.pid + '/status','utf8')); if (match) rss = Number(match[1]) * 1024; } catch {}
   }
   appendFileSync(trace, JSON.stringify({t:Number(process.hrtime.bigint())/1e6,rss,...event}) + '\\n');
 });
 pi.registerCommand('transfer-unload',{description:'Unload isolated native recognizer',handler: async () => unload()});
 pi.on('session_shutdown', async () => { try { await unload(); } finally { remove(); } });
 micme(pi);
}
`;
}

async function captureProcess(handle) {
	let stdout = "";
	let stderr = "";
	handle.child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
	handle.child.stderr.setEncoding("utf8").on("data", (text) => { stderr = (stderr + text).slice(-2_000); });
	handle.child.stdin.end();
	const result = await handle.close;
	if (result.code !== 0) throw new Error(`An isolated native comparator or Pi prerequisite did not complete (exit ${result.code}).`, { cause: stderr });
	return stdout.trim();
}

async function installTrial(state, assets, trial, p, signal) {
	const fixture = await readFixture(assets, trial);
	const recording = join(state.work, "capture");
	await writeFile(recording, "");
	await state.configure({ MICME_ARTIFACT: p.id, MICME_COMPUTE: "cpu", MICME_DETECTOR: "off", MICME_CHUNKING: "1", MICME_MODEL_IDLE: p.warm ? "never" : "immediate",
		MICME_MODEL_DIR: p.models, MICME_LANGUAGE: "en", MICME_TRANSCRIPTION_MODE: "stream", MICME_RECORD_COMMAND: recorderCommand(fixture.path, recording),
		...(trial.pairId.endsWith("-hang") ? { MICME_TRANSCRIBE_TIMEOUT_MS: "5000" } : {}) });
	signal.throwIfAborted();
	return { ...fixture, recording };
}

function expectedPrompt(prefix, raw) { return raw ? `${prefix}${prefix && !/\s$/u.test(prefix) && !".,!?;:)}]".includes(raw[0]) ? " " : ""}${raw} ` : prefix; }

function observedTarget(lines, text) {
	if (promptOnScreen(lines, text)) return true;
	// Long narrow prompts scroll at the cursor. The editor API supplies full
	// readback; the PTY independently confirms only the actually visible tail.
	const top = lines.findIndex((line) => /^\s*[─━]+\s+↑\s+\d+\s+more\s+[─━]+\s*$/u.test(line));
	if (top < 0) return false;
	const end = lines.findIndex((line, i) => i > top && /^\s*[─━]{5,}/u.test(line));
	if (end <= top + 1) return false;
	let prefix = text.replace(/\s+/gu, " ").trim();
	for (const line of lines.slice(top + 1, end).reverse()) {
		const part = line.replace(/\s+/gu, " ").trim();
		if (!part || !prefix.endsWith(part)) return false;
		prefix = prefix.slice(0, -part.length).trimEnd();
	}
	return prefix.length > 0;
}

function projectTarget(take, ui, frames, rel, clock) {
	const prefix = take.trial.prefix ?? "";
	const writes = ui.filter(({ kind }) => kind === "setEditorText" || kind === "pasteToEditor");
	take.sentCount = ui.filter(({ kind, queued }) => kind === "send" && !queued).length;
	take.queuedCount = ui.filter(({ kind, queued }) => kind === "send" && queued).length;
	take.expectedTarget = take.cleaned === null ? null : expectedPrompt(prefix, take.cleaned);
	for (const write of writes) {
		const frame = frames.find(({ stamp, lines }) => clock.ms(stamp) >= rel(write.t) && observedTarget(lines, write.text));
		if (!frame || write.text === prefix) continue;
		const ms = clock.ms(frame.stamp);
		take.mutations.push({ ms, text: write.text });
		if (write.kind === "setEditorText" && take.native?.route === "stream") take.commits.push({ ms, text: write.text.slice(prefix.length).trim() });
	}
	const candidate = take.mutations.at(-1)?.text ?? prefix;
	if (observedTarget(frames.at(-1)?.lines ?? [], candidate)) take.observedTarget = candidate;
	if (take.observedTarget?.startsWith(prefix)) take.delivered = take.observedTarget.slice(prefix.length).trim();
	const expected = take.mutations.find(({ text }) => text === take.expectedTarget);
	if (expected) take.events.push({ stage: "correctTarget", ms: expected.ms });
	if (take.commits.length) take.events.push({ stage: "firstCommit", ms: take.commits[0].ms });
	take.duplicateInsertions = Math.max(0, writes.filter(({ text }) => text === take.expectedTarget).length - 1);
	take.staleInsertions = writes.filter(({ text }) => take.expectedTarget !== null && !take.expectedTarget.trimEnd().startsWith(text.trimEnd())).length;
}

function projectTiming(take, capture, marked, frames, metadata, wire, rel, clock) {
	const first = capture.find(({ type }) => type === "capture-first");
	const closed = capture.find(({ type }) => type === "capture-close");
	const full = capture.find(({ type }) => type === "capture-end");
	const firstSample = first ? rel(first.t) : null;
	let span = { onsetMs: firstSample ?? 0, endMs: firstSample ?? 0, alignedWords: [] };
	if (first) {
		take.events.push({ stage: "firstSample", ms: firstSample });
		const ready = frames.find(({ stamp, lines }) => clock.ms(stamp) >= firstSample && lines.some((line) => /●\s+\d\d:\d\d:\d\d/u.test(line)));
		if (ready) take.events.push({ stage: "readyCue", ms: clock.ms(ready.stamp) });
		if (metadata?.words?.length && metadata.hash === take.trial.pcmSha256) {
			span = { onsetMs: firstSample + metadata.onsetMs, endMs: firstSample + metadata.endMs,
				alignedWords: metadata.words.map(({ word, endMs }) => ({ word, endMs: firstSample + endMs })) };
			take.events.push({ stage: "speechOnset", ms: span.onsetMs }, { stage: "speechEnd", ms: span.endMs });
		}
	}
	if (marked !== null) take.events.push({ stage: "stopGesture", ms: marked });
	const drained = wire.find(({ kind }) => kind === "finish") ?? wire.find(({ kind }) => kind === "snapshot");
	if (drained) take.events.push({ stage: "drained", ms: rel(drained.t) });
	if (closed) take.idleMicOpen = false; // staged recorder logged descriptor close, not system microphone state
	return { closed, full, span };
}

function wireEvent(event) {
	const row = { ...event };
	delete row.t;
	delete row.rss;
	return row;
}

function projectTake(take, window, metadata, comparison) {
	const { wire, capture, ui, rel, clock, frames, stop, error } = window;
	const { closed, full, span } = projectTiming(take, capture, stop, frames, metadata, wire, rel, clock);
	const loaded = wire.find(({ kind }) => kind === "loaded");
	const last = wire.find(({ kind }) => kind === "final");
	const endpoints = wire.filter(({ kind }) => kind === "endpoint").map(({ t, text }) => ({ ms: rel(t), text }));
	const stream = loaded?.traits.stream;
	if (loaded) {
		const { traits } = loaded;
		Object.assign(take.trial.rig, { actualBackend: traits.actualCompute, actualDevice: traits.boundDevice, threads: loaded.threads });
		take.events.push({ stage: "modelLoaded", ms: rel(loaded.t) });
	}
	let previous = "";
	for (const { stamp, lines } of frames) {
		const text = lines.find((line) => /^\s*Live: /u.test(line))?.trim() ?? "";
		if (clock.ms(stamp) >= 0 && text !== previous) { take.visible.push({ ms: clock.ms(stamp), text }); previous = text; }
	}
	if (loaded && last && closed && full && !window.fault) {
		const asrCalls = last.evidence.asrCalls - loaded.evidence.asrCalls;
		take.native = { route: stream ? "stream" : "batch", asrCalls, asrLoads: loaded.fresh ? loaded.evidence.asrLoads : 0,
			vadLoads: loaded.fresh ? loaded.evidence.vadLoads : 0, capturedSamples: full.samples, closedSamples: closed.samples, inputSamples: last.inputSamples,
			inputPcmSha256: last.inputPcmSha256, wire: stream ? wire.filter(({ kind }) => ["feed", "ack", "finish", "done"].includes(kind)).map(wireEvent) : null,
			endpoints, chunks: stream ? null : wire.filter(({ kind }) => kind === "batch").map(({ from, to, text }) => ({ from, to, text })),
			matchedClipRaw: comparison?.raw ?? null, workerCleanExit: false, ...span };
		take.pcmBytes = full.samples * 2;
		take.fedBytes = last.inputSamples * 2;
		take.fedSha256 = last.inputPcmSha256;
		take.audioMs = full.samples / 16;
		take.peakRssBytes = last.evidence.peakRssBytes;
		take.idleRssBytes = wire.find(({ kind, resident }) => kind === "released" && resident)?.rss ?? null;
		take.raw = last.final.raw;
		take.cleaned = last.final.local;
		take.events.push({ stage: "rawFinal", ms: rel(last.t) });
		if (endpoints.length) take.events.push({ stage: "firstEndpoint", ms: endpoints[0].ms });
		if (take.trial.referenceText && !negative.has(take.trial.fixture)) {
			const words = tokens(take.trial.referenceText);
			const tail = words.slice(-2).join(" ");
			take.missedOnset = !hasKeywords(take.raw, words.slice(0, 2).join(" "));
			const spokenTail = tokens(take.raw).join(" ");
			take.missedTail = take.trial.fixture === "continuous" ? !CONTINUOUS_KEYWORDS.terminalPhrases.some((ending) => spokenTail.endsWith(ending)) : !hasKeywords(take.raw, tail);
			take.repeatErrors = extraBoundaryRepeats(take.trial.referenceText, (take.native.chunks ?? endpoints).map(({ text }) => text)).length;
		}
	}
	projectTarget(take, ui, frames, rel, clock);
	if (window.replayed && take.cleaned !== null) take.replayed = window.replayed;
	if (window.fault || error || !last || !closed || !full) {
		take.outcome = window.injectedMs === undefined ? "failed" : window.fault === "hung" ? "timeout" : "lost";
		take.gaps.push({ stage: null, code: "no-result", detail: window.injectedMs === undefined ? error ?? "Missing native completion or recorder close." :
			`Owned native recognizer was ${window.fault} before finish; separate recovery observed if available.` });
	}
	take.events.sort((a, b) => a.ms - b.ms);
	return take;
}

async function signalOwnedWorker(pid, helper, signalName) {
	if (await realpath(`/proc/${pid}/exe`) !== helper) throw new Error("The observed native worker no longer belongs to the isolated trial.");
	process.kill(pid, signalName);
}

async function driveTake(state, pi, trial, fixture, native, helper, signal, { fault = false, overload = false } = {}) {
	const clock = takeClock();
	const originStamp = clock.stamp();
	const time = uptime();
	const rel = (t) => clock.ms(originStamp + (t - time));
	const nativeStart = (await traceRows(native)).length;
	const uiStart = (await traceRows(state.trace)).length;
	const prefix = trial.prefix ?? "";
	const window = { clock, rel, stop: null, fault, error: null, replayed: null, wire: [], frames: [], ui: [], capture: [] };
	pi.send(`\x15${prefix}`);
	if (prefix) await waitFor(() => promptOnScreen(pi.frames.at(-1)?.lines ?? [], prefix), signal, "Public sentinel did not render in the isolated prompt");
	const frameStart = pi.frames.length;
	window.trigger = clock.trigger();
	pi.send(alternateM);
	const trace = async () => (await traceRows(native)).slice(nativeStart);
	let pid;
	let stalled = false;
	try {
		const loaded = await waitFor(async () => (await trace()).find(({ kind }) => kind === "loaded"), signal, "Native recognizer did not load through the real Pi route", 15_000);
		pid = loaded.pid;
		if (overload && loaded.traits.stream) {
			await waitFor(async () => (await trace()).find(({ kind, through }) => kind === "ack" && through >= 48000), signal, "No live ACK before controlled CPU stall");
			await signalOwnedWorker(pid, helper, "SIGSTOP");
			stalled = true;
			await delay(1_500, undefined, { signal });
			await signalOwnedWorker(pid, helper, "SIGCONT");
			stalled = false;
		}
		await waitFor(async () => (await traceRows(fixture.recording)).find(({ type }) => type === "capture-end"), signal, "Paced public capture did not finish", fixture.pcm.length / 32 + 10_000);
		// The short negative WAV stays 20 ms. The legacy terminal shortcut
		// intentionally rejects a second physical gesture inside one second.
		if (clock.ms() < 1_100) await delay(1_100 - clock.ms(), undefined, { signal });
		if (fault) {
			await signalOwnedWorker(pid, helper, fault === "hung" ? "SIGSTOP" : "SIGKILL");
			window.injectedMs = clock.ms();
		}
		window.stop = clock.ms();
		pi.send(alternateM);
		if (fault) {
			const confirm = await waitFor(() => pi.frames.find(({ lines, stamp }) => clock.ms(stamp) >= window.stop && lines.some((line) => /Retry this audio|complete recording was verified/u.test(line))), signal, "No visible offer to retry verified recording", 20_000);
			window.confirmMs = clock.ms(confirm.stamp);
			pi.send("\r");
		}
		await waitFor(async () => (await traceRows(state.trace)).slice(uiStart).filter(({ kind }) => kind === "shortcut-end").length >= 2, signal, "Isolated stop gesture did not settle", 120_000);
		const final = (await trace()).find(({ kind }) => kind === "final");
		if (final?.final.local) await waitFor(() => observedTarget(pi.frames.at(-1)?.lines ?? [], expectedPrompt(prefix, final.final.local)), signal, "Completed take did not render in the destination prompt");
	} catch (error) { window.error = signal.aborted ? "Canceled by operator" : error.message; }
	finally { if (stalled) { try { await signalOwnedWorker(pid, helper, "SIGCONT"); } catch { /* Already exited. */ } } }
	window.wire = await trace();
	window.capture = await traceRows(fixture.recording);
	window.ui = (await traceRows(state.trace)).slice(uiStart);
	window.frames = pi.frames.slice(frameStart);
	if (!fault && !window.error) {
		const final = window.wire.find(({ kind }) => kind === "final")?.final.local;
		if (final) window.replayed = await observeReplay(pi, state, final, signal);
	}
	return window;
}

async function observeReplay(pi, state, text, signal) {
	const start = (await traceRows(state.trace)).length;
	const frameStart = pi.frames.length;
	enterCommand(pi, "/micme last");
	try {
		await waitFor(async () => (await traceRows(state.trace)).slice(start).some(({ kind }) => kind === "command-end"), signal, "Replay command was not dispatched");
		if (!pi.frames.slice(frameStart).some(({ lines }) => observedTarget(lines, text))) pi.send("\x1b[D");
		await waitFor(() => pi.frames.slice(frameStart).some(({ lines }) => observedTarget(lines, text)), signal, "Explicit replay did not render", 2_000);
		const rows = (await traceRows(state.trace)).slice(start);
		if (rows.some(({ kind }) => kind === "send")) throw new Error("Explicit isolated replay unexpectedly sent a message");
		return rows.find(({ kind }) => kind === "pasteToEditor")?.text.trim() ?? null;
	} catch { return null; }
}

async function replayGroup(trials, p, sidecar, signal, metadata, comparison) {
	const entry = join(p.local.workDir, `p4-${p.id.split("/")[0]}-observer.mjs`);
	const native = join(p.local.workDir, `p4-${p.id.split("/")[0]}-observer.jsonl`);
	await writeFile(entry, wrapper(native));
	await writeFile(native, "");
	const state = await isolatedPi({ root: p.local.workDir, entry, signal });
	const results = [];
	try {
		const models = join(state.work, "models");
		await mkdir(models, { mode: 0o700 });
		await copyFile(p.blob.file, join(models, basename(p.blob.blobPath)));
		const helper = join(state.work, "bin", "micme-recognizer");
		await copyFile(p.local.recognizerFile, helper);
		await chmod(helper, 0o500);
		if (await digest(helper) !== p.local.recognizerSha256) throw new Error("Staged recognizer does not match the selected pin.");
		const piVersion = await captureProcess(startIsolated(state, [p.local.piBinary, "--version"], { direct: true, signal }));
		const pi = observedPi(state, p.local.piBinary, trials[0].width, signal);
		await waitFor(async () => (await traceRows(state.trace)).some(({ kind }) => kind === "started"), signal, "No actual isolated Pi startup event");
		for (const t of trials) {
			// Pi suppresses terminal auto-repeat just after a shortcut invocation.
			if (results.length) await delay(1_100, undefined, { signal });
			t.rig.hostVersion = piVersion;
			try {
				if (t.cache === "idle-reload") await unloadFromPi(pi, native, signal);
				const fault = t.pairId.endsWith("-kill") ? "killed" : t.pairId.endsWith("-hang") ? "hung" : false;
				if ((fault || t.pairId.endsWith("-next")) && results.at(-1)?.window?.wire.some(({ kind, resident }) => kind === "released" && resident)) {
					await unloadFromPi(pi, native, signal);
				}
				const fixture = await installTrial(state, p.local.assetsDir, t, { ...p, models, warm: trials.length > 1 }, signal);
				let comparator = comparison.get(t.pcmSha256);
				if (!comparator && ["continuous", "jfk"].includes(t.fixture)) {
					comparator = JSON.parse(await captureProcess(startIsolated(state, [process.execPath, new URL(import.meta.url).pathname,
						"--comparator", sidecar, p.id, fixture.path, t.pcmSha256], { direct: true, signal })));
					comparison.set(t.pcmSha256, comparator);
				}
				const window = await driveTake(state, pi, t, fixture, native, helper, signal, { fault, overload: t.fixture === "overload" });
				if (window.error) console.error(`P4 ${t.pairId}: ${window.error}\n${pi.frames.at(-1)?.lines.join("\n") ?? pi.stderr()}`);
				const take = emptyTake(t, "completed", "no-result", "Pending native projection.");
				take.gaps = [];
				take.events.push(window.trigger);
				projectTake(take, window, metadata[t.fixture], comparator);
				results.push({ take, window });
			} catch (error) {
				console.error(`P4 ${t.pairId}: ${error.message}${error.cause ? `\n${error.cause}` : ""}`);
				results.push({ take: emptyTake(t, signal.aborted ? "failed" : "unavailable", signal.aborted ? "canceled" : "missing-input", qualificationError(error)) });
			}
		}
		enterCommand(pi, "/quit");
		await Promise.race([pi.close, delay(2_000)]);
		const wire = await traceRows(native);
		for (const { take, window } of results) {
			const first = window?.wire.find(({ kind }) => kind === "loaded");
			if (take.native && first) take.native.workerCleanExit = wire.some(({ kind, pid, evidence }) => kind === "released" && pid === first.pid && evidence.workerCleanExit);
		}
		return results;
	} finally { await closePi(state); }
}

async function unloadFromPi(pi, native, signal) {
	const start = (await traceRows(native)).length;
	enterCommand(pi, "/transfer-unload");
	await waitFor(async () => (await traceRows(native)).slice(start).some(({ kind, resident, evidence }) => kind === "released" && !resident && evidence.workerCleanExit),
		signal, "The resident recognizer did not exit on explicit unload");
}

function groupTrials(trials) {
	return trials.map((trial) => trial.fixture === "jfk" ? [trial,
		{ ...structuredClone(trial), pairId: `${trial.pairId}-warm`, cache: "warm-model" },
		{ ...structuredClone(trial), pairId: `${trial.pairId}-reload`, cache: "idle-reload" },
		{ ...structuredClone(trial), pairId: `${trial.pairId}-kill`, cache: "cold-process" },
		{ ...structuredClone(trial), pairId: `${trial.pairId}-kill-next`, cache: "cold-process" },
		{ ...structuredClone(trial), pairId: `${trial.pairId}-hang`, cache: "cold-process" },
		{ ...structuredClone(trial), pairId: `${trial.pairId}-hang-next`, cache: "cold-process" },
	] : [trial]);
}

export async function qualifyEngine(manifestPath, variantId, output) {
	const variant = getCatalogVariant(variantId);
	if (variant?.rights !== "cleared" || variant.blobs.length !== 1) throw new Error("Select a rights-cleared, exact native ledger variant.");
	await withInterrupts(collectEngine.bind(null, manifestPath, variant, output));
}

function qualificationError(error) {
	return error?.path ? "A pinned local fixture or isolated qualification file was missing or inaccessible." : error.message;
}

async function collectEngine(manifestPath, variant, output, signal) {
	const protocol = await readJson(manifestPath, validateProtocol);
	const local = await loadLocal(manifestPath);
	const frozen = await readJson(new URL("./transfer-p1-manifest.json", import.meta.url), validateProtocol);
	const manifestSha256 = await digest(manifestPath);
	const sourceSha256 = await piSourceSha256(checkout);
	const trials = qualificationTrials(protocol, frozen, manifestSha256, variant, local);
	if (!trials.length) throw new Error("The manifest declares no public English Pi destination trials.");
	let p;
	let gap;
	try { p = { ...await preflight(manifestPath, variant), id: variant.id }; }
	catch (error) { gap = qualificationError(error); }
	const metadata = p ? JSON.parse(await readFile(join(p.local.assetsDir, "transfer-fixtures.json"), "utf8").catch(() => "{}")).fixtures ?? {} : {};
	const comparison = new Map();
	const destination = await open(output, "wx", 0o600);
	const receipts = [];
	try {
		for (const group of groupTrials(trials)) {
			let runs;
			try { if (p) runs = await replayGroup(group, p, manifestPath, signal, metadata, comparison); }
			catch (error) { gap = qualificationError(error); }
			for (const { take, window } of runs ?? group.map((t) => ({ take: emptyTake(t, "unavailable", "missing-input", gap ?? "Local qualification prerequisite missing.") }))) {
				validateTake(take);
				await destination.writeFile(`${JSON.stringify(take)}\n`);
				const score = scoreTake(take);
				receipts.push({ pairId: take.trial.pairId, score: score.status, gates: score.gates, wer: score.wer,
					fault: window?.fault ? { kind: window.fault, error: window.error, injectedMs: window.injectedMs ?? null, confirmMs: window.confirmMs ?? null,
						wire: window.wire.filter(({ kind }) => ["loaded", "failed", "released", "snapshot", "final"].includes(kind)).map(({ t, ...event }) => ({ ms: window.rel(t), ...event })),
						capture: window.capture.map(({ t, ...event }) => ({ ms: window.rel(t), ...event })), mutations: take.mutations } : null });
			}
		}
	} finally { await destination.close(); }
	if (await piSourceSha256(checkout) !== sourceSha256) throw new Error("The product source changed during qualification. Keep these observations separate and rerun before publication.");
	await writeFile(`${output}.receipts.json`, `${JSON.stringify({ variantId: variant.id, sourceSha256,
		manifestSha256, comparison: Object.fromEntries(comparison), receipts }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	console.log(`Native P4 ${variant.id}: ${receipts.length} independently scored takes; ${receipts.filter(({ score }) => score === "pass").length} pass.`);
}

async function comparator(manifest, variantId, fixture, pcmSha256) {
	const { createRecognitionService } = await import("../../src/transfer/recognition.ts");
	const { loadEngine } = await import("../../src/transfer/engine.ts");
	const local = await loadLocal(manifest);
	const wav = await readFile(fixture);
	const { pcmFromWav } = await import("./transfer-fixtures.mjs");
	if (hash(pcmFromWav(wav)) !== pcmSha256) throw new Error("Comparator input differs from the frozen PCM.");
	const service = createRecognitionService({ load: (choice, signal) => loadEngine(choice, signal, {
		recognizerFile: local.recognizerFile, recognizerSha256: local.recognizerSha256, engineModelFiles: local.engineModelFiles,
	}) });
	const audio = { bytes: wav.length, sha256: hash(wav), copyTo: async (directory) => {
		const path = join(directory.filesPath, "fixture.wav");
		const fd = directory.createPrivateFile(path);
		try { writeFileSync(fd, wav); } finally { closeSync(fd); }
		return path;
	} };
	try {
		const result = await service.recognizeFile(audio, { variantId, compute: "cpu", requestedDeviceId: null, language: "en", task: "transcribe", detector: "off", chunking: false },
			"cli", () => {}, AbortSignal.timeout(60_000), { whole: true });
		console.log(JSON.stringify({ raw: result.raw, compute: result.actualCompute, device: result.boundDevice, pcmSha256 }));
	} finally { await service.unload(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === "--comparator") {
	await comparator(...process.argv.slice(3));
}
