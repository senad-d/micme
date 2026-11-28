import { constants, createReadStream } from "node:fs";
import { access, lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { arch, cpus, platform, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { wavHeader } from "./corpus.mjs";
import { readFixture } from "./transfer-fixtures.mjs";
import { emptyTake, loadLocal, takeClock } from "./transfer-runner.mjs";
import { isPlannedTake, readJson, validateProtocol } from "./transfer-schema.mjs";
import { extraBoundaryRepeats, hasKeywords, previewProgress, tokens } from "./scoring.mjs";
import { alternateM, closePi, enterCommand, isolatedPi, observedPi, promptOnScreen, promptReadbackOnScreen, recorderCommand,
	startIsolated, traceRows, waitFor } from "./transfer-pi-local.mjs";

const identities = Object.freeze({
	"micme-041": { checkout: "tagCheckout", tag: "v0.4.1", commit: "481e3e30ac6138108341ad41a0579da80a321a3e", version: "0.4.1", label: "tag 0.4.1 (legacy SDL, not Worker v1)" },
	"micme-70ad138": { checkout: "historicalCheckout", commit: "70ad13862563aa46b7bd76411a1df852d9c740b7", label: "historical 70ad138 (Worker v1)" },
	"micme-current": { checkout: "currentCheckout", version: "0.5.0", label: "current 0.5.0 source (Worker v1)" },
});
const negative = new Set(["silence", "noise", "immediate"]);
const normalize = (text) => stripVTControlCharacters(text).replace(/\s+/gu, " ").trim();
const uptimeMs = () => Number(process.hrtime.bigint()) / 1e6;
const observationUrl = new URL("./worker-observer.mjs", import.meta.url).href;

class GapError extends Error {
	constructor(code, detail) { super(detail); this.code = code; }
}
function block(code, detail) { throw new GapError(code, detail); }

async function hashFile(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function sourceFiles(base, relative) {
	if (!(await lstat(join(base, relative))).isDirectory()) throw new Error("Pi source receipt requires ordinary source directories");
	const items = await readdir(join(base, relative), { withFileTypes: true });
	const descendants = [];
	for (const item of items) {
		const name = `${relative}/${item.name}`;
		if (item.isDirectory()) descendants.push(...await sourceFiles(base, name));
		else if (item.isFile() && /\.(?:ts|mts|cts|js|mjs|cjs|json)$/u.test(item.name)) descendants.push(name);
		else if (item.isSymbolicLink()) throw new Error("Pi source receipt requires an ordinary source tree, not symlinked source entries");
	}
	return descendants;
}

// The operator binds this receipt to a separately verified clean checkout of the
// full commit. Recompute source bytes before activation; package version alone and
// a binary standing in for another product are never accepted as provenance.
export async function piSourceSha256(root) {
	const files = ["package.json", "package-lock.json", ...await sourceFiles(root, "src")].sort();
	const digest = createHash("sha256");
	for (const file of files) {
		const path = join(root, file);
		if (!(await lstat(path)).isFile()) throw new Error("Pi source receipt requires ordinary source files");
		digest.update(`${file}\0${await hashFile(path)}\n`);
	}
	return digest.digest("hex");
}

async function pinnedFile(path, sha, label, executable = false) {
	if (!path || !sha) block("missing-input", `Supply the explicit ${label} and its pinned SHA-256.`);
	let resolved;
	try {
		resolved = await realpath(path);
		if (!(await lstat(resolved)).isFile()) throw new Error("not an ordinary file");
		await access(resolved, executable ? constants.R_OK | constants.X_OK : constants.R_OK);
	} catch { block("missing-input", `The pinned ${label} file is not available.`); }
	if ((await hashFile(resolved)) !== sha) block("identity-mismatch", `The ${label} SHA-256 does not match provisioning.`);
	return resolved;
}

async function preflight(trial, local) {
	const id = identities[trial.product];
	if (!id) block("unsupported", "Not a Micme product.");
	const build = trial.build;
	if ((id.commit && build.commit && build.commit !== id.commit) || (id.tag && build.tag && ![id.tag, id.version].includes(build.tag))) {
		block("identity-mismatch", `Frozen identity is not ${id.label}.`);
	}
	const source = local?.[id.checkout];
	if (!source) block("missing-input", `Supply ${id.checkout} for ${id.label}; no other Pi checkout was used.`);
	if (!/^[\da-f]{40}$/u.test(build.commit ?? "") || !local.workDir) block("missing-input", `Pin the full ${id.label} commit and provide its source receipt in workDir.`);
	let receipt, sourceSha256, pkg;
	try {
		receipt = JSON.parse(await readFile(join(local.workDir, "transfer-pi-sources.json"), "utf8"))[trial.product];
		sourceSha256 = await piSourceSha256(source);
		pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	} catch { block("missing-input", `Cannot read verified source bytes and transfer-pi-sources.json for ${id.label}.`); }
	if (!receipt) block("missing-input", `No source receipt for ${id.label}.`);
	if (receipt.commit !== build.commit || receipt.sourceSha256 !== sourceSha256 || (id.version && pkg.version !== id.version) ||
		pkg.name !== "@senad-d/micme" || !pkg.pi?.extensions?.includes("./src/extension.ts")) {
		block("identity-mismatch", `Source tree, commit receipt or package entry disagrees with ${id.label}.`);
	}
	if (platform() !== "linux") block("missing-host", "Pi collection requires the Linux PTY and socket sandbox.");
	if (trial.input === "physical") block("missing-permission", "No physical microphone is activated by the collector.");
	if (trial.input === "loopback") block("no-observer", "No isolated hardware loopback was provisioned for this slot; a paced WAV hook is not loopback.");
	if (trial.cache !== "cold-process" || trial.disk === "cold-proven" || trial.load !== "idle" || trial.processing !== "off") {
		block("unsupported", "No matching warm-model, idle-reload, proven cold-disk, contended, or processed Pi observation in this collector.");
	}
	if (trial.track !== "pcm" && (trial.gesture !== "toggle" || (trial.target !== "none" && trial.target !== "pi-prompt"))) {
		block("unsupported", "The Pi terminal collector observes an Alt+M toggle and the Pi prompt only.");
	}
	if (trial.track === "destination" && (!trial.width || trial.target !== "pi-prompt" || !trial.prefix?.trim() || /[\p{C}\r\n]/u.test(trial.prefix))) {
		block("missing-input", "Freeze the public printable prompt prefix, Pi target, and real terminal width (40 or 80).");
	}
	if (trial.track === "pcm" && (trial.target !== "none" || trial.fixture === "overload")) {
		block("unsupported", "Direct PCM has no destination or paced overload gesture.");
	}
	// Worker v1 uses the pinned binary's default, not an explicit CPU selection.
	// Accept a CPU condition only if the decoder diagnostics establish CPU use.
	if (trial.rig.requestedDevice !== null && trial.rig.requestedDevice !== "cpu") {
		block("unsupported", "This Pi collector has no accelerator or device-specific compute selection.");
	}
	const routed = trial.track !== "pcm";
	const routeRig = { display: routed ? "Linux PTY" : null, mic: routed ? "paced public WAV hook" : null,
		gpu: null, driver: null, threads: null, actualDevice: null };
	for (const [key, observed] of Object.entries(routeRig)) {
		if (trial.rig[key] !== null && trial.rig[key] !== observed) block("identity-mismatch", `The isolated Pi route does not establish the planned ${key}.`);
	}
	const files = local.backendFiles.find((file) => file.product === trial.product);
	if (trial.product === "micme-041" && (trial.track !== "pcm" || (files?.streamSha256 && build.binarySha256 === files.streamSha256))) {
		block("no-observer", "Tag 0.4.1 native streaming uses SDL capture; supply a separately isolated SDL loopback. The legacy stdout fixture is not native audio or a destination measurement.");
	}
	if (!local.piBinary) block("missing-host", "Supply the explicitly installed Pi executable; no global Pi was used.");
	if (!files || !local.assetsDir) block("missing-input", `Supply per-product native binaries and prepared public fixtures for ${id.label}.`);
	const batch = trial.product === "micme-041";
	const backendHash = batch ? files.clipSha256 : files.workerSha256;
	if (!backendHash || !build.binarySha256) block("missing-input", `Pin the actual ${batch ? "clip" : "Worker v1"} binary in the build and sidecar.`);
	if (backendHash !== build.binarySha256) block("identity-mismatch", `Frozen ${id.label} binary differs from its per-product provisioning.`);
	const clip = await pinnedFile(files.clipFile, files.clipSha256, "whole-file Whisper comparator", true);
	const worker = batch ? null : await pinnedFile(files.workerFile, files.workerSha256, "Worker v1", true);
	const modelFile = basename(build.modelFile ?? "");
	const model = local.whisperModelFiles.find(({ name, file }) => Boolean(modelFile) && [name, basename(file), name && `ggml-${name}.bin`].includes(modelFile));
	if (model && build.modelSha256 && model.sha256 !== build.modelSha256) block("identity-mismatch", "Planned model and provisioned model digests differ.");
	const weight = await pinnedFile(model?.file, build.modelSha256, "Whisper weight");
	const vad = batch ? null : await pinnedFile(local.vadFile, receipt.vadSha256, "Silero VAD weight");
	let fixture;
	try { fixture = await readFixture(local.assetsDir, trial); }
	catch (error) { block(error.code === "ENOENT" ? "missing-input" : "identity-mismatch", "Prepared public WAV is missing or does not match the pinned PCM."); }
	const binary = await pinnedFile(local.piBinary, receipt.piSha256, "installed Pi executable", true);
	return { entry: join(source, "src", "extension.ts"), binary, worker, clip, weight, vad, fixture, batch, local, routeRig };
}

function sampleSettings(trial, p, file) {
	return { MICME_TRANSCRIPTION_MODE: "stream", MICME_TRANSCRIBE_BACKEND: "whisper.cpp", MICME_RECORD_COMMAND: recorderCommand(file.sample, file.capture),
		MICME_LIVE_BIN: file.proxy, MICME_WHISPER_CPP_BIN: p.clip, MICME_WHISPER_CPP_MODEL: p.weight, MICME_VAD_MODEL: p.vad,
		MICME_LANGUAGE: trial.language ?? "auto", MICME_TRANSLATE_TO_ENGLISH: trial.task === "translate-en" ? (trial.language ?? "auto") : "",
		MICME_PROCESS_AUDIO: "0", MICME_STREAM_FINALIZE_WITH_CLIP: "0", MICME_STREAM_DIAGNOSTICS: "1", MICME_SHORTCUT: "alt+m" };
}

async function prepare(state, trial, p) {
	const file = { sample: join(state.project, "public-sample.wav"), capture: join(state.work, "capture.jsonl"), wire: join(state.work, "wire.jsonl"),
		proxy: join(state.work, "observed-worker") };
	await writeFile(file.sample, Buffer.concat([wavHeader(p.fixture.pcm.length), p.fixture.pcm]));
	if (p.worker) await writeFile(file.proxy, `#!${process.execPath}\nimport { forwardWorker } from ${JSON.stringify(observationUrl)};\nawait forwardWorker(...${JSON.stringify([p.worker, file.wire, trial.fixture === "overload"])});\n`, { mode: 0o700 });
	return { ...file, settings: sampleSettings(trial, p, file) };
}

function spawned(state, argv, signal) {
	const handle = startIsolated(state, argv, { direct: true, signal });
	let err = "";
	handle.child.stderr.setEncoding("utf8").on("data", (data) => { err = (err + data).slice(-32_000); });
	return { ...handle, diagnostics: () => err };
}

async function runFile(state, argv, signal) {
	const run = spawned(state, argv, signal);
	let out = "";
	run.child.stdout.setEncoding("utf8").on("data", (data) => { out = (out + data).slice(-4_000); });
	run.child.stdin.end();
	const exit = await run.close;
	return { ...exit, out, diagnostics: run.diagnostics() };
}

async function clipPass(state, trial, p, file, signal) {
	const output = join(state.work, "clip");
	const result = await runFile(state, [p.clip, "-ng", "-t", "4", "-l", trial.language ?? "auto", ...(trial.task === "translate-en" ? ["-tr"] : []),
		"-m", p.weight, "-f", file.sample, "-oj", "-of", output, "-nt"], signal);
	if (result.code !== 0) return { ...result, text: null };
	const book = JSON.parse(await readFile(`${output}.json`, "utf8"));
	return { ...result, text: normalize(book.transcription.map(({ text }) => text).join(" ")) };
}

async function directWorker(state, trial, p, file, signal) {
	const worker = spawned(state, [file.proxy, "--model", p.weight, "--vad-model", p.vad, "--language", trial.language ?? "auto",
		...(trial.task === "translate-en" ? ["--translate"] : [])], signal);
	const messages = createInterface({ input: worker.child.stdout });
	const events = messages[Symbol.asyncIterator]();
	try {
		let ready = false;
		let finishing = false;
		for (let through = 0; ;) {
			const item = await events.next();
			if (item.done) throw new Error("Worker exited before done");
			const e = JSON.parse(item.value);
			if (e.type === "error") throw new Error("Worker reported an error");
			if (e.type === "done") {
				if (!finishing || e.through !== through) throw new Error("Worker finished prematurely or at the wrong sample");
				break;
			}
			if (e.type !== "ready" && e.type !== "ack") continue;
			if (e.type === "ready") {
				if (ready || e.version !== 1 || e.rate !== 16_000) throw new Error("Unexpected Worker v1 readiness event");
				ready = true;
			} else if (!ready || finishing || e.through !== through) throw new Error("Unexpected Worker acknowledgment");
			if (through * 2 >= p.fixture.pcm.length) { finishing = true; worker.child.stdin.end(Buffer.of(3)); continue; }
			const block = p.fixture.pcm.subarray(through * 2, (through + 1600) * 2);
			const header = Buffer.alloc(5, 2);
			header.writeUInt32LE(block.length / 2, 1);
			through += block.length / 2;
			worker.child.stdin.write(Buffer.concat([header, block]));
		}
	} finally { messages.close(); worker.child.stdin.end(); }
	await worker.close;
}

const editorWrites = (rows) => rows.filter(({ kind }) => kind === "setEditorText" || kind === "pasteToEditor");

function renderedTarget(frame, writes, clock, rel, prefix) {
	if (!frame) return null;
	const ms = clock.ms(frame.stamp);
	const latest = writes.findLast(({ t }) => rel(t) <= ms);
	if (latest) return promptReadbackOnScreen(frame.lines, latest.text) ? latest.text : null;
	return promptOnScreen(frame.lines, prefix) ? prefix : null;
}

function replayOnScreen(lines, text) {
	if (promptReadbackOnScreen(lines, text)) return true;
	// Pi deliberately folds large pastes. The frame corroborates the paste,
	// while the expanded editor readback supplies text the user cannot see.
	const count = text.split("\n").length;
	const size = count > 10 ? `+${count} lines` : `${text.length} chars`;
	return lines.some((line) => {
		const marker = line.trim();
		return /^\[paste #\d+ /u.test(marker) && marker.endsWith(` ${size}]`) && promptOnScreen(lines, marker);
	});
}

async function driveTerminal(state, trial, p, file, take, clock, rel, signal) {
	const pi = observedPi(state, p.binary, trial.width ?? 80, signal);
	let replayFrom = Infinity;
	try {
		await waitFor(async () => (await traceRows(state.trace)).some(({ kind }) => kind === "started"), signal, "Pi session did not reach its real startup event.");
		if (trial.target === "pi-prompt") {
			pi.send(trial.prefix);
			await waitFor(() => promptOnScreen(pi.frames.at(-1)?.lines ?? [], trial.prefix), signal, "Public sentinel did not render in the Pi prompt.");
		}
		take.events.push(clock.trigger());
		pi.send(alternateM);
		const start = await waitFor(async () => (await traceRows(state.trace)).find(({ kind }) => kind === "shortcut"), signal,
			"Pi did not dispatch the first Alt+M gesture.");
		await waitFor(async () => (await traceRows(file.capture)).some(({ type }) => type === "capture-end"), signal,
			"Paced recorder did not reach the end of the public file.", p.fixture.pcm.length / 32 + 25_000);
		// Legacy Alt+M bytes carry no key-up event. Do not treat an ignored
		// auto-repeat as stop, even when the fixture itself is only one block.
		const stopWait = rel(start.t) + 1_100 - clock.ms();
		if (stopWait > 0) await delay(stopWait, undefined, { signal });
		const stop = clock.ms();
		pi.send(alternateM);
		await waitFor(async () => (await traceRows(state.trace)).filter(({ kind }) => kind === "shortcut-end").length === 2, signal, "The real stop shortcut did not settle.", 25_000);
		take.events.push({ stage: "stopGesture", ms: stop });
		if (!(await traceRows(file.capture)).some(({ type }) => type === "capture-close")) throw new Error("The stop shortcut did not close the recorder.");
		if (trial.target === "pi-prompt") {
			const writes = editorWrites(await traceRows(state.trace));
			await waitFor(() => {
				const frame = pi.frames.at(-1);
				return frame && clock.ms(frame.stamp) >= stop && renderedTarget(frame, writes, clock, rel, trial.prefix) !== null;
			}, signal, "The stopped Pi prompt was not independently observed on screen.");
		}
		replayFrom = clock.ms();
		enterCommand(pi, "/micme last");
		const replayRows = await waitFor(async () => {
			const rows = await traceRows(state.trace);
			return rows.some(({ kind }) => kind === "command-end") && rows;
		}, signal, "Pi did not dispatch explicit /micme last.");
		const replay = replayRows.findLast(({ kind, t }) => kind === "pasteToEditor" && rel(t) >= replayFrom);
		if (!replay && rawWords(await traceRows(file.wire))) throw new Error("Explicit replay did not reach the editor.");
		if (replay) {
			const rendered = () => pi.frames.some(({ lines, stamp }) => clock.ms(stamp) >= rel(replay.t) && replayOnScreen(lines, replay.text));
			if (!rendered()) pi.send("\x1b[D");
			await waitFor(rendered, signal, "Explicit replay was not rendered.");
		}
		return { frames: pi.frames, replayFrom, error: null };
	} catch (error) { return { frames: pi.frames.slice(), replayFrom, error }; }
	finally {
		enterCommand(pi, "/quit");
		await Promise.race([pi.close, new Promise((done) => setTimeout(done, 250).unref())]);
		pi.abort();
		await pi.close;
	}
}

function rawWords(rows) {
	return normalize(rows.filter(({ event }) => event?.type === "final").map(({ event }) => event.text).join(" "));
}

function append(prefix, text) {
	if (!text) return prefix;
	return `${prefix}${prefix && !/\s$/u.test(prefix) && !".,!?;:)}]".includes(text[0]) ? " " : ""}${text} `;
}

function computeBackend(output) {
	const diagnostics = output.split(/\nwhisper_vad_/u, 1)[0];
	if (/whisper_backend_init_gpu: using .*Metal|ggml_backend_metal_device_init:.*using/iu.test(diagnostics)) return "metal";
	if (/whisper_backend_init_gpu: using .*Vulkan/iu.test(diagnostics)) return "vulkan";
	if (/whisper_backend_init_gpu: no GPU found|use gpu\s*= 0|using CPU backend/iu.test(diagnostics)) return "cpu";
	return "unknown";
}

async function alignment(trial, p, take, first) {
	if (negative.has(trial.fixture)) return { onsetMs: first, endMs: first, alignedWords: [] };
	let entry;
	try { entry = JSON.parse(await readFile(join(p.local.assetsDir, "transfer-fixtures.json"), "utf8")).fixtures[trial.fixture]; }
	catch { /* optional metadata; never synthesize human alignment from ASR */ }
	const spans = entry?.words;
	if (entry?.hash === trial.pcmSha256 && Number.isFinite(entry.onsetMs) && Number.isFinite(entry.endMs) && Array.isArray(spans) &&
		spans.length && spans.every(({ word, endMs }, i) => word?.trim() && Number.isFinite(endMs) && endMs > (spans[i - 1]?.endMs ?? entry.onsetMs)) &&
		entry.endMs <= take.audioMs && spans.at(-1).endMs === entry.endMs && entry.onsetMs >= 0) {
		return { onsetMs: first + entry.onsetMs, endMs: first + entry.endMs, alignedWords: spans.map(({ word, endMs }) => ({ word, endMs: first + endMs })) };
	}
	if (trial.track !== "pcm") take.gaps.push({ stage: "speechOnset", code: "missing-input", detail: "Human onset/end and word alignment were not supplied for this fixture." });
	return { onsetMs: first, endMs: first, alignedWords: [] };
}

function timeEvents(take, loaded, done, finish, endpoints, rel) {
	if (loaded) take.events.push({ stage: "modelLoaded", ms: rel(loaded.t) });
	if (finish && take.trial.track !== "pcm") take.events.push({ stage: "drained", ms: rel(finish.t) });
	if (done) take.events.push({ stage: "rawFinal", ms: rel(done.t) });
	if (endpoints.length) take.events.push({ stage: "firstEndpoint", ms: endpoints[0].ms });
}

function observePrompt(take, ui, terminal, clock, rel) {
	const prefix = take.trial.prefix ?? "";
	const { replayFrom, frames } = terminal;
	const writes = editorWrites(ui).filter(({ t }) => rel(t) < replayFrom);
	let prior = prefix;
	for (const write of writes.filter(({ kind }) => kind === "setEditorText")) {
		if (prior !== write.text) take.commits.push({ ms: rel(write.t), text: write.text.startsWith(prior) ? write.text.slice(prior.length).trim() : write.text });
		prior = write.text;
	}
	if (take.commits.length) take.events.push({ stage: "firstCommit", ms: take.commits[0].ms });
	take.sentCount = ui.filter(({ kind, queued }) => kind === "send" && !queued).length;
	take.queuedCount = ui.filter(({ kind, queued }) => kind === "send" && queued).length;
	const replay = ui.find(({ kind, t }) => kind === "pasteToEditor" && rel(t) >= replayFrom);
	if (replay && frames.some(({ lines, stamp }) => clock.ms(stamp) >= rel(replay.t) && replayOnScreen(lines, replay.text))) take.replayed = replay.text.trim();
	if (take.trial.target !== "pi-prompt") return;
	take.expectedTarget = take.raw === null ? null : append(prefix, take.raw);
	const beforeReplay = frames.filter(({ stamp }) => clock.ms(stamp) >= 0 && clock.ms(stamp) < replayFrom);
	let previous = prefix;
	for (const frame of beforeReplay) {
		const text = renderedTarget(frame, writes, clock, rel, prefix);
		if (text !== null && text !== previous) {
			take.mutations.push({ ms: clock.ms(frame.stamp), text });
			previous = text;
		}
	}
	take.observedTarget = renderedTarget(beforeReplay.at(-1), writes, clock, rel, prefix);
	if (take.observedTarget?.startsWith(prefix)) take.delivered = take.observedTarget.slice(prefix.length).trim();
	const match = take.mutations.find(({ text }) => text === take.expectedTarget);
	if (match) take.events.push({ stage: "correctTarget", ms: match.ms });
	take.staleInsertions = take.mutations.filter(({ text }) => !take.expectedTarget?.trimEnd().startsWith(text.trimEnd())).length;
	take.duplicateInsertions = Math.max(0, take.mutations.filter(({ text }) => text === take.expectedTarget).length - 1);
}

async function projectStream(take, p, file, state, terminal, clock, rel) {
	const rows = await traceRows(file.wire);
	const capture = await traceRows(file.capture);
	const loaded = rows.find(({ event }) => event?.type === "ready");
	const done = rows.find(({ event }) => event?.type === "done");
	const exit = rows.find(({ type }) => type === "worker-exit");
	const finish = rows.find(({ type }) => type === "finish");
	const complete = capture.find(({ type }) => type === "capture-end");
	const closed = capture.find(({ type }) => type === "capture-close");
	const first = capture.find(({ type }) => type === "capture-first");
	const endpoints = rows.filter(({ event }) => event?.type === "final").map(({ t, event }) => ({ ms: rel(t), text: event.text }));
	timeEvents(take, loaded, done, finish, endpoints, rel);
	const stream = !terminal;
	const captureSamples = stream ? p.fixture.pcm.length / 2 : complete?.samples ?? closed?.samples;
	const closedSamples = stream ? captureSamples : closed?.samples;
	const span = await alignment(take.trial, p, take, first ? rel(first.t) : 0);
	if (first) take.events.push({ stage: "firstSample", ms: rel(first.t) });
	if (first && span.alignedWords.length) take.events.push({ stage: "speechOnset", ms: span.onsetMs }, { stage: "speechEnd", ms: span.endMs });
	const wire = [];
	for (const row of rows) {
		if (row.type === "feed") wire.push({ kind: "feed", from: row.through - row.samples, through: row.through, catchUp: row.op === 2 });
		else if (row.type === "finish") wire.push({ kind: "finish" });
		else if (row.event?.type === "ack" || row.event?.type === "done") wire.push({ kind: row.event.type, through: row.event.through });
	}
	if (captureSamples !== undefined && closedSamples !== undefined && finish) take.native = { route: "stream", asrCalls: done?.event.asrCalls ?? null,
		asrLoads: loaded?.event.asrLoads ?? null, vadLoads: loaded?.event.vadLoads ?? null, capturedSamples: captureSamples, closedSamples,
		inputSamples: finish.fed, inputPcmSha256: finish.sha256, wire, endpoints, chunks: null, matchedClipRaw: null, ...span, workerCleanExit: exit?.code === 0 };
	take.pcmBytes = captureSamples === undefined ? null : captureSamples * 2;
	take.fedBytes = finish ? finish.fed * 2 : null;
	take.fedSha256 = finish?.sha256 ?? null;
	take.computeMs = done?.event.asrMs ?? null;
	take.peakRssBytes = exit?.peakRssKiB ? exit.peakRssKiB * 1024 : null;
	take.raw = done ? rawWords(rows) : null;
	if (terminal) {
		const ui = await traceRows(state.trace);
		observePrompt(take, ui, terminal, clock, rel);
		let last = "";
		for (const { stamp, lines } of terminal.frames) {
			const ms = clock.ms(stamp);
			if (ms < 0 || ms >= terminal.replayFrom) continue;
			const draft = lines.find((line) => /^\s*Live: /u.test(line))?.trim() ?? "";
			if (draft !== last) { take.visible.push({ ms, text: draft }); last = draft; }
		}
		const stop = take.events.find(({ stage }) => stage === "stopGesture")?.ms;
		const ready = first && terminal.frames.find(({ stamp, lines }) => clock.ms(stamp) >= rel(first.t) && clock.ms(stamp) < (stop ?? Infinity)
			&& lines.some((line) => /●\s+\d\d:\d\d:\d\d/u.test(line)));
		if (ready) take.events.push({ stage: "readyCue", ms: clock.ms(ready.stamp) });
		const words = span.alignedWords.flatMap(({ word, endMs }) => tokens(word).map((word) => ({ word, endMs })));
		if (words.length && (endpoints.length > 0 || exit?.code === 0) && stop !== undefined) {
			const progress = previewProgress(take.visible.map(({ ms: t, text: line }) => ({ t, line })), words, span.onsetMs,
				Math.min(endpoints[0]?.ms ?? Infinity, span.endMs, stop));
			// previewProgress returns latency from speech onset, not a trial timestamp.
			if (progress.firstCorrectMs !== null) take.events.push({ stage: "firstUseful", ms: span.onsetMs + progress.firstCorrectMs });
		}
		for (const { lines } of terminal.frames) {
			const lag = lines.join(" ").match(/peak\s+lag\s+(\d+)\s+samples/u)?.[1];
			if (lag !== undefined) take.peakLagSamples = Number(lag);
		}
	}
	if (take.raw !== null && take.trial.referenceText && take.trial.task === "transcribe") {
		const words = tokens(span.alignedWords.map(({ word }) => word).join(" "));
		if (words.length) {
			take.missedOnset = !hasKeywords(take.raw, words.slice(0, 2).join(" "));
			const tail = words.slice(-2).join(" ");
			take.missedTail = !hasKeywords(take.raw, tail) && !(take.trial.fixture === "continuous" && tail.endsWith("1863") && hasKeywords(take.raw, tail.replace(/1863$/u, "eighteen sixty three")));
		}
		take.repeatErrors = extraBoundaryRepeats(take.trial.referenceText, endpoints.map(({ text }) => text)).length;
	}
	return { backend: computeBackend(exit?.stderr ?? ""), clean: Boolean(done && exit?.code === 0) };
}

export async function collect(trial, signal, { local, clock = takeClock() } = {}) {
	const label = identities[trial.product]?.label ?? "unknown Pi identity";
	let state;
	let take;
	try {
		signal?.throwIfAborted();
		const p = await preflight(trial, local);
		state = await isolatedPi({ root: tmpdir(), entry: p.entry, signal });
		const file = await prepare(state, trial, p);
		const host = await runFile(state, [p.binary, "--version"], signal);
		const hostVersion = host.code === 0 && /^\d+\.\d+\.\d+[^\r\n]*$/u.test(host.out.trim()) ? host.out.trim() : null;
		if (!hostVersion) block("missing-host", "Installed Pi could not report its host version in the isolated profile.");
		const rig = { ...trial.rig, ...p.routeRig, os: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null, hostVersion, actualBackend: "unknown" };
		take = { ...emptyTake({ ...trial, rig }, "completed", "no-result", ""), gaps: [], audioMs: p.fixture.pcm.length / 32 };
		await state.configure(file.settings);
		// Both child observers use the same Linux CLOCK_MONOTONIC as Node hrtime.
		// Bind that shared clock once to the runner's own monotonic timestamp.
		const stamp = clock.stamp();
		const base = uptimeMs();
		const rel = (ms) => clock.ms(stamp + (ms - base));
		let backend;
		if (p.batch) {
			take.events.push(clock.trigger());
			const clip = await clipPass(state, trial, p, file, signal);
			if (clip.text === null) throw new Error("Direct native clip returned no result.");
			take.raw = clip.text;
			take.events.push({ stage: "rawFinal", ms: clock.ms() });
			take.gaps.push({ stage: null, code: "no-observer", detail: "Whole-file clip does not report native ASR call counts or a consumed-PCM digest; no complete batch gate claimed." });
			backend = computeBackend(clip.diagnostics);
		} else {
			let terminal;
			let directError;
			if (trial.track === "pcm") {
				take.events.push(clock.trigger());
				try { await directWorker(state, trial, p, file, signal); } catch (error) { directError = error; }
			} else terminal = await driveTerminal(state, trial, p, file, take, clock, rel, signal);
			if (take.events.some(({ stage }) => stage === "trigger")) {
				const native = await projectStream(take, p, file, state, terminal, clock, rel);
				backend = native.backend;
				if (!native.clean || directError || terminal?.error) throw new Error("Native worker or terminal observation did not complete.");
			} else throw new Error("The isolated terminal did not reach the recording gesture.");
			if (take.native) {
				const clip = await clipPass(state, trial, p, file, signal);
				take.native.matchedClipRaw = clip.text;
				if (clip.text === null) take.gaps.push({ stage: "rawFinal", code: "no-result", detail: "The separate matched-PCM/weight comparator failed." });
			}
		}
		take.trial.rig.actualBackend = backend;
		if (trial.rig.requestedDevice === "cpu" && backend !== "cpu") {
			const detail = "The decoder did not establish the planned CPU backend.";
			if (backend !== "unknown") block("identity-mismatch", detail);
			// Missing backend proof invalidates the condition, not the capture receipt.
			take.outcome = "unavailable";
			take.gaps.push({ stage: null, code: "no-observer", detail });
		} else if (backend === "unknown") {
			take.gaps.push({ stage: null, code: "no-observer", detail: "Native diagnostics did not identify the loaded compute backend." });
		}
		if (!isPlannedTake(trial, take.trial)) block("identity-mismatch", "Observed host, backend, or device does not match the frozen condition.");
	} catch (error) {
		if (signal?.aborted) return emptyTake(trial, "lost", "canceled", `${label}: interrupted and isolated children closed.`);
		if (error instanceof GapError) return emptyTake(trial, "unavailable", error.code, `${label}: ${error.message}`);
		if (!take) return emptyTake(trial, "failed", "no-result", `${label}: isolated preflight could not run.`);
		take.outcome = "failed";
		take.gaps.push({ stage: null, code: "no-result", detail: `${label}: isolated native or terminal observation did not complete.` });
	} finally { if (state) await closePi(state); }
	take.events.sort((a, b) => a.ms - b.ms);
	return take;
}

export async function localNativeOptions(manifest) {
	const protocol = await readJson(manifest, validateProtocol);
	const local = await loadLocal(manifest);
	const trial = protocol.trials.find(({ product, track, input }) => product === "micme-current" && track !== "pcm" && input === "file");
	if (!trial) throw new Error("Explicit native replay needs a current Pi paced public file slot; no scripted fallback.");
	const p = await preflight(trial, local);
	return { binary: p.binary, entry: p.entry, prepare: (state) => prepare(state, trial, p) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 4 || process.argv[2] !== "--source-sha256") {
		console.error("Usage: node test/live-native/transfer-pi.mjs --source-sha256 CHECKOUT");
		process.exitCode = 2;
	} else {
		try { console.log(await piSourceSha256(resolve(process.argv[3]))); }
		catch { console.error("Cannot hash the supplied Pi source checkout (need ordinary package, lockfile, and src files)."); process.exitCode = 1; }
	}
}
