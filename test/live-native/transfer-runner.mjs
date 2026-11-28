import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalKey, conditionKey, isPlannedTake, readJson, validateLocal, validateProtocol, validateTake } from "./transfer-schema.mjs";
import { validateFrozenCalibration } from "./transfer-report.mjs";

const adjacentName = "transfer-local.json";
const nativeTimeoutMs = 180_000;
const teardownMs = 2_000;
const observedText = ["expectedTarget", "observedTarget", "raw", "cleaned", "replayed", "delivered"];

export function emptyTake(trial, outcome, code, detail) {
	return {
		trial, native: null, outcome, gaps: [{ stage: null, code, detail }], events: [], visible: [], commits: [], mutations: [],
		expectedTarget: null, observedTarget: null, raw: null, cleaned: null, replayed: null, delivered: null,
		sentCount: null, queuedCount: null, pcmBytes: null, fedBytes: null, fedSha256: null, computeMs: null, audioMs: null,
		peakLagSamples: null, peakRssBytes: null, idleRssBytes: null, idleMicOpen: null, missedOnset: null, missedTail: null,
		repeatErrors: null, staleInsertions: null, duplicateInsertions: null,
	};
}

export async function loadLocal(manifestPath) {
	try {
		return await readJson(resolve(dirname(manifestPath), adjacentName), validateLocal);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

// The clock is created by the runner; a collector calls trigger just before
// the actual gesture/input and projects ONLY local monotonic stamps onto it.
export function takeClock(onTrigger) {
	let origin;
	return Object.freeze({
		stamp: () => performance.now(),
		trigger() {
			if (origin !== undefined) throw new Error("Trial is already triggered");
			origin = performance.now();
			const event = { stage: "trigger", ms: 0 };
			onTrigger?.(event);
			return event;
		},
		ms(stamp = performance.now()) {
			if (origin === undefined) throw new Error("No trial trigger observed");
			return stamp - origin;
		},
	});
}

function orderHash(...values) {
	return createHash("sha256").update(canonicalKey(values)).digest("hex");
}

// Same seed and manifest always give the same schedule. Pair members run next
// to one another; rotate which build goes first, including across warm pairs.
export function interleaveTrials(protocol) {
	const cohorts = new Map();
	const buildOrder = new Map(protocol.products.map((b, i) => [canonicalKey(b), i]));
	const preceding = new Map();
	for (const trial of protocol.trials) {
		const key = canonicalKey([conditionKey(trial, false), trial.pairId, trial.repeatIndex]);
		if (!cohorts.has(key)) cohorts.set(key, []);
		cohorts.get(key).push(trial);
	}
	return [...cohorts.entries()].sort(([a], [b]) => orderHash(protocol.createdUtc, a).localeCompare(orderHash(protocol.createdUtc, b)))
		.flatMap(([, trials]) => {
			trials.sort((a, b) => buildOrder.get(canonicalKey(a.build)) - buildOrder.get(canonicalKey(b.build)));
			const cell = conditionKey(trials[0], false);
			const previous = preceding.get(cell) ?? Number.parseInt(orderHash(protocol.createdUtc, cell).slice(0, 6), 16);
			preceding.set(cell, previous + 1);
			const offset = previous % trials.length;
			return trials.slice(offset).concat(trials.slice(0, offset));
		});
}

async function collectorFor(product) {
	const module = product === "handy-0102" ? "./transfer-handy.mjs" : "./transfer-pi.mjs";
	try {
		return (await import(module)).collect;
	} catch (error) {
		if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === new URL(module, import.meta.url).href) return null;
		throw error;
	}
}

function redactPhysical(take) {
	if (take?.trial?.input !== "physical") return take;
	const copy = { ...take, visible: [], commits: [], mutations: [], gaps: take.gaps?.map(({ stage, code }) => ({ stage, code, detail: "Private trial observation withheld." })) };
	for (const field of observedText) copy[field] = null;
	if (take.native) copy.native = { ...take.native, matchedClipRaw: null, alignedWords: [], endpoints: [], chunks: null };
	return copy;
}

async function attempt(trial, collect, context, stopSignal, timeoutMs, injected) {
	if (stopSignal?.aborted) return [emptyTake(trial, "unavailable", "canceled", "Run canceled before this planned take."), false];
	if (!injected && !context.local) return [emptyTake(trial, "unavailable", "missing-input", "Supply the adjacent transfer-local.json with explicit local provisioning."), true];
	if (!injected && (trial.input === "physical" || !trial.pcmSha256)) {
		return [emptyTake(trial, "unavailable", "missing-input", trial.input === "physical" ?
			"Physical microphone replay needs a separately consented and isolated collector; no microphone activated." : "Pin the public fixture PCM digest before collecting."), true];
	}
	if (typeof collect !== "function") return [emptyTake(trial, "unavailable", "no-observer", "Install the corresponding isolated product collector."), true];

	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), timeoutMs);
	const signal = stopSignal ? AbortSignal.any([stopSignal, deadline.signal]) : deadline.signal;
	let trigger;
	const clock = takeClock((event) => { if (!signal.aborted) trigger = { ...event }; });
	let cancel;
	const interrupted = new Promise((done) => {
		cancel = () => done(null);
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
	});
	const planned = structuredClone(trial);
	const collecting = Promise.resolve().then(() => {
		if (!signal.aborted) return collect(structuredClone(planned), signal, { ...context, clock });
	}).then((take) => ({ take }), () => ({ failed: true }));
	try {
		const result = await Promise.race([collecting, interrupted]);
		if (signal.aborted || result === null) {
			const settled = await waitForTeardown(collecting);
			const canceled = stopSignal?.aborted;
			const take = emptyTake(trial, canceled ? "lost" : "timeout", canceled ? "canceled" : "no-result",
				canceled ? "Run canceled during collection." : "Collector exceeded the per-take deadline.");
			take.events = interruptedEvents(trial, settled?.take, trigger);
			return [take, Boolean(settled)];
		}
		if (result.failed) return [emptyTake(trial, "failed", "no-result", "Collector failed before returning evidence; inspect the private local diagnostics."), true];
		try {
			const take = validateTake(redactPhysical(result.take));
			if (!isPlannedTake(trial, take.trial)) return [emptyTake(trial, "failed", "identity-mismatch", "Returned build, rig or input does not match the frozen slot."), true];
			return [take, true];
		} catch {
			return [emptyTake(trial, "failed", "no-result", "Collector did not return a complete public V1 Take."), true];
		}
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

function interruptedEvents(trial, receipt, trigger) {
	let events = [];
	try {
		// Keep stage observations from a partial receipt, not a late completion.
		if (receipt && receipt.outcome !== "completed" && isPlannedTake(trial, validateTake(redactPhysical(receipt)).trial)) events = receipt.events;
	} catch {
		// The runner's own pre-abort trigger is still evidence.
	}
	// A partial receipt can preserve measurements, but only the runner's live
	// clock can attest that the trigger was reached before interruption.
	const measured = events.filter(({ stage }) => stage !== "trigger");
	if (trigger) measured.push(trigger);
	return measured.sort((a, b) => a.ms - b.ms);
}

async function waitForTeardown(collecting) {
	const cancel = new AbortController();
	try {
		return await Promise.race([collecting, delay(teardownMs, null, { signal: cancel.signal })]);
	} finally {
		cancel.abort();
	}
}

async function saveManifest(path, protocol) {
	const file = await open(path, "wx", 0o644);
	try {
		await file.writeFile(`${JSON.stringify(protocol, null, 2)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
}

// Exclusive creation protects evidence from concurrent runs and accidental
// replacement. The adjacent plan copy is durable before any activation.
export async function runTransfer(manifestPath, output, { signal, timeoutMs = nativeTimeoutMs, collectors = null } = {}) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError("Invalid collector timeout");
	const protocol = await readJson(manifestPath, validateProtocol);
	validateFrozenCalibration(protocol);
	const local = collectors ? null : await loadLocal(manifestPath);
	const context = { manifestPath: resolve(manifestPath), local };
	const totals = { completed: 0, failed: 0, timeout: 0, lost: 0, unavailable: 0 };
	if ([output, `${output}.manifest.json`].some((path) => /(?:^|[/\\])transfer-local\.json$/.test(path))) throw new Error("Output cannot be the private provisioning sidecar");
	const normalizedOutput = resolve(await realpath(dirname(output)), basename(output));
	const file = await open(normalizedOutput, "ax", 0o644);
	const adapters = new Map();
	let safeToContinue = true;
	try {
		await saveManifest(`${normalizedOutput}.manifest.json`, protocol);
		for (const trial of interleaveTrials(protocol)) {
			let take;
			if (!safeToContinue) take = emptyTake(trial, "unavailable", "unsafe-instance", "Earlier collector did not settle after abort; no subsequent product was activated.");
			else {
				let collect = collectors?.[trial.product];
				if (!collectors && local && !signal?.aborted && trial.input !== "physical" && trial.pcmSha256) {
					if (!adapters.has(trial.product)) adapters.set(trial.product, await collectorFor(trial.product).catch(() => false));
					collect = adapters.get(trial.product);
				}
				if (collect === false) take = emptyTake(trial, "failed", "no-observer", "The isolated product collector could not load.");
				else [take, safeToContinue] = await attempt(trial, collect, context, signal, timeoutMs, Boolean(collectors));
			}
			await file.appendFile(`${JSON.stringify(take)}\n`, "utf8");
			await file.sync();
			totals[take.outcome]++;
		}
	} finally {
		await file.close();
	}
	return totals;
}

export async function withInterrupts(run) {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		return await run(controller.signal);
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
