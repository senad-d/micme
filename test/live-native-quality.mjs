import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, release, totalmem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashFile, prepareCorpus, RATE } from "./live-native/corpus.mjs";
import { extraBoundaryRepeats, hasKeywords, nearestRank, previewProgress, scoreDraftTrace, tokens, visibleWords, wordErrors } from "./live-native/scoring.mjs";

const runFile = promisify(execFile);
const observer = new URL("live-native/worker-observer.mjs", import.meta.url).href;
const recorder = fileURLToPath(new URL("live-native/paced-recorder.mjs", import.meta.url));
const widths = [80, 40];
const repeats = 5;
const clock = () => Number(process.hrtime.bigint()) / 1e6;
const round = (x) => Math.round(x * 100) / 100;
const describe = (error) => error instanceof Error ? error.message : String(error);

async function traceRows(path) {
	try {
		return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((row) => JSON.parse(row));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function runClip(bin, model, entry, work) {
	const prefix = join(work, "clip");
	const start = clock();
	const { stderr } = await runFile(bin, ["-ng", "-t", "4", "-l", entry.language ?? "en", "-m", model, "-f", entry.path,
		"-oj", "-of", prefix, "-nt"], { timeout: 120_000 });
	const wallMs = round(clock() - start);
	const raw = JSON.parse(await readFile(`${prefix}.json`, "utf8"));
	const text = raw.transcription.map((span) => span.text.trim()).join(" ");
	return { text, wallMs, ...wordErrors(entry.reference, text),
		diagnostics: stderr.split("\n").filter((line) => /system_info|threads|backend|load time|encode time|decode time/i.test(line)) };
}

function tuiContext(work) {
	const handlers = new Map();
	const draft = [];
	const commits = [];
	const notices = [];
	const statuses = [];
	const sent = [];
	const pasted = [];
	let editor = "";
	const ctx = {
		mode: "tui", cwd: work, hasUI: true, isIdle: () => true,
		ui: {
			theme: { fg: (_kind, text) => text, bold: (text) => text },
			setWidget(key, rows) {
				if (key !== "micme-recording") return;
				assert.ok(rows === undefined || Array.isArray(rows));
				const line = rows?.find((text) => text.startsWith("Live: ")) ?? "";
				if (line !== (draft.at(-1)?.line ?? "")) draft.push({ t: clock(), line });
			},
			getEditorText: () => editor,
			setEditorText(text) { editor = text; commits.push({ t: clock(), text }); },
			pasteToEditor(text) { editor += text; pasted.push(text); },
			notify(message, level) { notices.push({ t: clock(), level, message }); },
			setStatus(_key, text) { statuses.push({ t: clock(), text }); },
		},
	};
	return {
		ctx, handlers, draft, commits, sent, pasted, notices, statuses,
		pi: {
			registerCommand: (name, { handler }) => handlers.set(name, handler),
			on: (event, handler) => handlers.set(event, handler),
			registerShortcut() {}, registerMessageRenderer() {},
			sendUserMessage(text) { sent.push(text); },
		},
		command: (args = "") => handlers.get("micme")(args, ctx),
		editorText: () => editor,
	};
}

async function waitForCaptureEnd(trace, ui, entry, recordingStarted) {
	const deadline = recordingStarted + entry.samples / RATE * 1_000 + 10_000;
	while (clock() < deadline) {
		if (ui.notices.some(({ level }) => level === "error")) return;
		if ((await traceRows(trace)).some(({ type }) => type === "capture-end")) return;
		await delay(15);
	}
	throw new Error("Paced recorder did not report its last PCM block");
}

async function runLive(entry, width, paths, work, refine = false) {
	const capture = join(work, "capture.jsonl");
	const wire = join(work, "worker.jsonl");
	const proxy = join(work, "quality-worker.mjs");
	await writeFile(proxy, `#!${process.execPath}\nimport { forwardWorker } from ${JSON.stringify(observer)};\nawait forwardWorker(...${JSON.stringify([paths.worker, wire, Boolean(entry.slow)])});\n`, { mode: 0o700 });
	Object.assign(process.env, {
		MICME_LIVE_BIN: proxy, MICME_VAD_MODEL: paths.vad,
		MICME_WHISPER_CPP_MODEL: paths.model, MICME_LANGUAGE: entry.language ?? "en",
		MICME_STREAM_FINALIZE_WITH_CLIP: refine ? "1" : "0",
		MICME_RECORD_COMMAND: `exec ${[process.execPath, recorder].map(paths.quote).join(" ")} {audio} ${[entry.path, capture].map(paths.quote).join(" ")}`,
	});
	const plan = paths.resolvePlan();
	assert.deepEqual([plan.binary, plan.modelPath, plan.vadModelPath, plan.language, plan.translate, plan.finalizeWithClip],
		[proxy, paths.model, paths.vad, entry.language ?? "en", false, refine]);
	const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "columns", { value: width, configurable: true });
	const ui = tuiContext(work);
	let commandAt;
	let readyAt;
	let stopAt;
	let stopReturned;
	let final = "";
	let failure;
	try {
		paths.register(ui.pi);
		await ui.handlers.get("session_start")({}, ui.ctx);
		commandAt = clock();
		await ui.command();
		readyAt = clock();
		if (entry.samples > RATE / 50) await waitForCaptureEnd(capture, ui, entry, readyAt);
		stopAt = clock();
		if (!ui.notices.some(({ level }) => level === "error")) await ui.command();
		stopReturned = clock();
		final = ui.editorText().trim();
		await ui.command("last");
	} catch (error) {
		failure = describe(error);
	} finally {
		await ui.handlers.get("session_shutdown")?.({}, ui.ctx);
		if (columns) Object.defineProperty(process.stdout, "columns", columns);
		else delete process.stdout.columns;
	}
	const captureRows = await traceRows(capture);
	const wireRows = await traceRows(wire);
	const origin = captureRows.find(({ type }) => type === "capture-start")?.t ?? commandAt ?? clock();
	const relative = (t) => t === undefined ? null : round(t - origin);
	const timed = (items) => items.map((item) => ({ ...item, t: relative(item.t) }));
	const events = timed(wireRows.filter(({ type }) => type === "event"));
	const done = events.find(({ event }) => event.type === "done");
	const loaded = events.find(({ event }) => event.type === "ready");
	const lastPcm = captureRows.find(({ type }) => type === "capture-end");
	const closed = captureRows.find(({ type }) => type === "capture-close");
	const finish = wireRows.find(({ type }) => type === "finish");
	const exit = wireRows.find(({ type }) => type === "worker-exit");
	const { feeds, catchUp, peakInFlight, exactAcks } = checkWire(wireRows);
	const peakLag = ui.notices.map(({ message }) => message.match(/peak lag (\d+) samples/)).find(Boolean)?.[1];
	const draft = ui.draft.map(({ t, line }) => ({ t: t - origin, line }));
	const endpoint = wireRows.find(({ type, event }) => type === "event" && event.type === "final");
	const firstEndpoint = endpoint ? endpoint.t - origin : null;
	const firstCommit = ui.commits[0];
	const finalWrite = ui.commits.at(-1);
	const noErrors = !failure && ui.notices.every(({ level }) => level !== "error") && exit?.code === 0;
	const coverage = noErrors && lastPcm?.samples === entry.samples && closed?.samples === entry.samples && done?.event.through === entry.samples &&
		finish?.sha256 === entry.hash && exactAcks && peakInFlight === 1 && loaded?.event.asrLoads === 1 && loaded.event.vadLoads === 1;
	const correctDelivery = !ui.sent.length && (final ? ui.pasted.length === 1 && ui.pasted[0] === `${final} ` : !ui.pasted.length);
	const scoring = entry.words ? {
		visibleRelevance: scoreDraftTrace(draft, entry.words, entry.onsetMs, entry.endMs),
		boundaryRepeats: extraBoundaryRepeats(entry.reference, events.filter(({ event }) => event.type === "final").map(({ event }) => event.text)),
		...previewProgress(draft, entry.words, entry.onsetMs, Math.min(entry.endMs, firstEndpoint ?? Infinity, stopAt === undefined ? Infinity : stopAt - origin)),
	} : {};
	return {
		width, refine, failure: failure ?? null, coverage, noErrors, correctDelivery, text: final, replay: ui.pasted, sent: ui.sent, ...wordErrors(entry.reference, final),
		keywordsPass: hasKeywords(final, entry.keywords ?? ""), anyVisibleWords: draft.some(({ line }) => visibleWords(line).length > 0),
		firstWorkerTextMs: events.find(({ event }) => event.type === "partial" && tokens(event.text).length > 0)?.t ?? null,
		firstEndpointMs: endpoint ? relative(endpoint.t) : null, firstCommitMs: relative(firstCommit?.t),
		startupMs: readyAt === undefined ? null : round(readyAt - commandAt), loadMs: loaded?.event.loadMs ?? null,
		lastPcmMs: relative(lastPcm?.t), stopMs: relative(stopAt), doneMs: done?.t ?? null,
		stopToDoneMs: done && stopAt !== undefined ? round(done.t - relative(stopAt)) : null,
		lastPcmToDoneMs: done && lastPcm ? round(done.t - relative(lastPcm.t)) : null,
		stopToReturnMs: stopReturned === undefined ? null : round(stopReturned - stopAt),
		lastPcmToFinalWriteMs: finalWrite && lastPcm ? round(finalWrite.t - lastPcm.t) : null,
		maxPaceDelayMs: lastPcm?.maxPaceDelayMs === undefined ? null : round(lastPcm.maxPaceDelayMs),
		peakLagSamples: peakLag === undefined ? null : Number(peakLag),
		asrToAudio: done ? done.event.asrMs / (entry.samples * 1_000 / RATE) : null,
		fed: finish?.fed ?? null, sha256: finish?.sha256 ?? null, captured: closed?.samples ?? null,
		feeds, catchUp, exactAcks, peakInFlight, peakRssKiB: exit?.peakRssKiB ?? null,
		workerStderr: exit?.stderr, wirePath: wire, capturePath: capture,
		draft, commits: timed(ui.commits), notices: timed(ui.notices), statuses: timed(ui.statuses),
		events: events.filter(({ event }) => event.type !== "ack"), ...scoring,
	};
}

function checkWire(rows) {
	let exactAcks = true;
	let catchUp = 0;
	let feeds = 0;
	let peakInFlight = 0;
	const pending = [];
	for (const { type, event, op, through } of rows) {
		if (type === "feed") {
			pending.push(through);
			feeds++;
			if (op === 2) catchUp++;
			peakInFlight = Math.max(peakInFlight, pending.length);
		} else if (type === "event" && event.type === "ack" && pending.shift() !== event.through) {
			exactAcks = false;
		}
	}
	return { exactAcks: exactAcks && pending.length === 0, catchUp, feeds, peakInFlight };
}

function gradeEnglish(test, cases) {
	const grade = {};
	for (const width of widths) {
		const runs = test.live.continuous.filter((r) => r.width === width);
		const values = runs.map((r) => r.firstCorrectMs);
		const median = nearestRank(values, 0.5);
		const p95 = nearestRank(values, 0.95);
		grade[width] = {
			values, median, p95, relevance: runs.length === repeats && runs.every((r) => r.visibleRelevance.pass),
			responsive: runs.length === repeats && median <= 3_000 && p95 <= 5_000 && runs.every((r) => r.multiple),
		};
	}
	const accuracy = ["jfk", "continuous"].every((name) => !test.clip[name].error && test.live[name].every((r) => r.wer <= 0.2 && r.wer - test.clip[name].wer <= 0.1));
	const speech = ["jfk", "continuous", "short", "quiet", "pause", "repeat", "overload"].every((name) => test.live[name].every((r) => r.text && r.keywordsPass));
	const silence = ["silence", "noise", "immediate"].every((name) => test.live[name].every((r) => !r.text && !r.anyVisibleWords && !r.commits.length &&
		(name !== "silence" || r.events.find(({ event }) => event.type === "done")?.event.asrCalls === 0)));
	const names = Object.keys(cases).filter((name) => name !== "french");
	const coverage = names.every((name) => test.live[name].every((r) => r.coverage));
	const delivery = names.every((name) => test.live[name].every((r) => r.correctDelivery));
	const compared = names.every((name) => !test.clip[name].error);
	const overload = test.live.overload.every((r) => r.coverage && r.catchUp > 0);
	const rollover = test.live.continuous.every((r) => !r.boundaryRepeats.length);
	const ratio = test.live.continuous.map((r) => r.asrToAudio);
	return { widths: grade, accuracy, speech, silence, coverage, delivery, compared, overload, rollover, computeAim: ratio.every((r) => r !== null && r < 1),
		pass: accuracy && speech && silence && coverage && delivery && compared && overload && rollover && Object.values(grade).every((r) => r.relevance && r.responsive) };
}

async function attempt(fn) {
	try { return await fn(); } catch (error) { return { error: describe(error) }; }
}

async function evaluate(assets, worker, clip, output) {
	const host = { os: process.platform, kernel: release(), arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
		availableCpus: availableParallelism(), memoryBytes: totalmem(), node: process.version };
	const result = { host, widths, repeats, configurations: {}, status: "incomplete",
		unmeasured: ["physical microphone", "legacy SDL matched replay", "accelerator"] };
	const checkpoint = () => writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
	await mkdir(dirname(output), { recursive: true });
	try {
		assert.notEqual(process.platform, "win32", "The paced recorder and protocol observer require a POSIX host");
		const work = await mkdtemp(join(tmpdir(), "micme-quality-"));
		const agent = join(work, "pi-agent");
		await mkdir(agent);
		// Dedicated process: no user overrides, model downloads, saved configuration or audio retention.
		for (const key of Object.keys(process.env)) if (key.startsWith("MICME_")) delete process.env[key];
		Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, TMPDIR: work, MICME_TRANSCRIPTION_MODE: "stream",
			MICME_TRANSCRIBE_BACKEND: "whisper.cpp", MICME_AUTO_DOWNLOAD_MODEL: "0", MICME_STREAM_DIAGNOSTICS: "1",
			MICME_AUTO_SUBMIT: "0", MICME_PROCESS_AUDIO: "0", MICME_WHISPER_CPP_BIN: clip });
		const vad = join(assets, "ggml-silero-v5.1.2.bin");
		await Promise.all([access(worker, constants.X_OK), access(clip, constants.X_OK), access(vad, constants.R_OK)]);
		assert.equal(execFileSync(worker, ["--protocol-version"], { encoding: "utf8", timeout: 3_000 }), "1\n");
		result.binaries = { worker: await hashFile(worker), clip: await hashFile(clip), vad: await hashFile(vad),
			clipVersion: execFileSync(clip, ["--version"], { encoding: "utf8", timeout: 3_000 }).trim(),
			ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 3_000 }).split("\n")[0] };
		const cases = await prepareCorpus(assets, work);
		result.cases = cases;
		const { registerMicmeExtension: register } = await import("../src/extension.ts");
		const { resolveLivePlan: resolvePlan } = await import("../src/live-plan.ts");
		const { shellQuote: quote } = await import("../src/processes.ts");
		const resolved = { register, resolvePlan, quote, worker, vad };
		for (const name of ["base.en", "small.en", "base"]) {
			const model = join(assets, `ggml-${name}.bin`);
			const test = result.configurations[name] = { model: await attempt(() => hashFile(model)), clip: {}, live: {} };
			if (test.model.error) { await checkpoint(); continue; }
			const measured = name === "base" ? ["french"] : Object.keys(cases).filter((id) => id !== "french");
			for (const id of measured) {
				const entry = cases[id];
				const dir = join(work, name, id);
				await mkdir(dir, { recursive: true });
				test.clip[id] = await attempt(() => runClip(clip, model, entry, dir));
				test.live[id] = [];
				for (const width of id === "continuous" ? widths : [80]) {
					for (let i = 1; i <= (id === "continuous" ? repeats : 1); i++) {
						const runDir = join(dir, `${width}-${i}`);
						await mkdir(runDir);
						const live = await runLive(entry, width, { ...resolved, model }, runDir);
						test.live[id].push(live);
						console.log(`${name} ${id} ${width}c ${i}: coverage=${live.coverage}; WER=${live.wer}; relevance=${live.visibleRelevance?.hits ?? "n/a"}/${live.visibleRelevance?.checkpoints.length ?? "n/a"}`);
						await checkpoint();
					}
				}
			}
			if (name !== "base") {
				const refined = join(work, name, "refine");
				await mkdir(refined);
				test.refinement = await runLive(cases.jfk, 80, { ...resolved, model }, refined, true);
				test.gates = gradeEnglish(test, cases);
			} else {
				const french = test.live.french[0];
				test.sameLanguagePass = french.coverage && french.correctDelivery && french.keywordsPass && !test.clip.french.error;
			}
			await checkpoint();
		}
		const english = [result.configurations["base.en"], result.configurations["small.en"]];
		result.englishGate = english.some((test) => test.gates?.pass);
		const supplemental = result.configurations.base.sameLanguagePass;
		const missing = Object.values(result.configurations).some((test) => test.model.error);
		result.status = missing ? "missing prerequisite" : result.englishGate && supplemental ? "passed" : "failed";
	} catch (error) {
		result.error = describe(error);
		result.status = "incomplete";
	}
	await checkpoint();
	console.log(`Native quality: ${result.status}. Results: ${output}${result.error ? ` (${result.error})` : ""}`);
	return result.status === "passed" ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.length === 3 && args[0] === "--prepare") {
	const destination = resolve(args[2]);
	await mkdir(destination, { recursive: true });
	const cases = await prepareCorpus(resolve(args[1]), destination);
	await writeFile(join(destination, "corpus.json"), `${JSON.stringify(cases, null, 2)}\n`);
} else if (args.length === 4) {
	process.exitCode = await evaluate(...args.map((p) => resolve(p)));
} else {
	console.error("Usage: npm run test:live-native -- ASSETS_DIR MICME_LIVE WHISPER_CLI RESULTS_JSON\n       npm run test:live-native -- --prepare ASSETS_DIR WAV_DIRECTORY");
	process.exitCode = 2;
}
