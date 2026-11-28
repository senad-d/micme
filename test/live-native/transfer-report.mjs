import { lstat, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { CONTINUOUS_KEYWORDS } from "./corpus.mjs";
import { extraBoundaryRepeats, hasKeywords, nearestRank, previewProgress, scoreDraftTrace, tokens, wordErrors } from "./scoring.mjs";
import { Run, canonicalKey, conditionKey, isPlannedTake, readJson, readJsonl, validateEvidencePath, validateProtocol, validateScorecardRow, validateTake } from "./transfer-schema.mjs";

export const SCORECARD_INPUTS = Object.freeze([
	"transfer-q-p1.jsonl", "transfer-q-p2.jsonl", "transfer-q-p3.jsonl", "transfer-q-p4.jsonl", "transfer-q-p5.jsonl", "transfer-q-p6.jsonl",
	"transfer-q-p7-import.jsonl", "transfer-q-p7-cli.jsonl", "transfer-q-p8-provider.jsonl", "transfer-q-p8-final.jsonl",
]);
const manifestName = "transfer-p1-manifest.json";
const phases = [1, 2, 3, 4, 5, 6, 7, 7, 8, 8];
const negativeFixtures = new Set(["silence", "noise", "immediate"]);
const previewStages = new Set(["firstUseful", "firstEndpoint", "firstCommit"]);
const standardBands = Object.freeze([
	["trigger", "modelLoaded"], ["trigger", "firstSample"], ["trigger", "readyCue"], ["speechOnset", "firstUseful"],
	["speechOnset", "firstEndpoint"], ["speechOnset", "firstCommit"], ["stopGesture", "drained"], ["stopGesture", "rawFinal"],
	["stopGesture", "correctTarget"], ["trigger", "rawFinal"], ["rawFinal", "polishDone"], ["polishDone", "hookDone"],
].map(([from, to]) => ({ from, to, ms: null })));
const keywords = {
	jfk: "fellow americans ask not ask what you can do for your country", continuous: CONTINUOUS_KEYWORDS,
	overload: "fellow americans ask not ask what you can do for your country", short: "thank you", quiet: "but now very much",
	pause: "but now doesn't seem very much", repeat: "but now but now very much", french: "Paris",
};

function measured(value, message) {
	return { state: value === null ? "unverified" : value ? "pass" : "fail", message };
}
const na = (message) => ({ state: "not-applicable", message });
const wordsPresent = (s) => s !== null && tokens(s).length > 0;

export function scoreWire(wire, samples, overload = false) {
	if (wire === null) return measured(null, "No stream wire observer");
	let pending = null;
	let cursor = 0;
	let finished = false;
	let done = false;
	let caughtUp = false;
	for (const w of wire) {
		if (done) return measured(false, "Wire observation follows done");
		switch (w.kind) {
			case "feed":
				if (finished || pending !== null || w.from !== cursor || w.through <= w.from || w.through > samples) {
					return measured(false, "Feeds must be contiguous with at most one ACK outstanding");
				}
				pending = w.through;
				caughtUp ||= w.catchUp;
				break;
			case "ack":
				if (pending !== w.through) return measured(false, "Missing, mismatched or out-of-order ACK");
				cursor = pending;
				pending = null;
				break;
			case "finish":
				if (finished || pending !== null || cursor !== samples) return measured(false, "Finish before the last matching ACK");
				finished = true;
				break;
			case "done":
				if (!finished || w.through !== samples) return measured(false, "Done must follow finish at the captured total");
				done = true;
				break;
		}
	}
	return measured(done && (!overload || caughtUp), done ? (overload && !caughtUp ? "No overload catch-up feed" : "Ordered feeds, exact ACKs and final drain") : "Missing exact finish/done");
}

function ordered(items, value = ({ ms }) => ms) {
	return items.every((item, i) => !i || value(items[i - 1]) <= value(item));
}

function hasGap(take, ...stages) {
	return take.gaps.some(({ stage }) => stage === null || stages.includes(stage));
}

function eventMap(take) {
	const times = new Map();
	for (const { stage, ms } of take.events) if (!times.has(stage)) times.set(stage, ms);
	return times;
}

function scorePreview(take, times, wire) {
	const { native: n, trial: t } = take;
	const continuous = t.fixture === "continuous";
	const pairedBeforeEnd = n && n.alignedWords.filter(({ endMs }) => endMs < n.endMs).length >= 2;
	// An empty trace does not make a planned preview inapplicable.
	const applies = t.width !== null && t.track !== "pcm" && (continuous || pairedBeforeEnd);
	if (!applies) return { preview: na("Not a display fixture with applicable aligned preview"), firstUsefulMs: null };
	if (n?.route === "batch") return { preview: na("Batch route does not produce speculative drafts"), firstUsefulMs: null };
	if (!n) return { preview: measured(null, "Missing native endpoint/alignment observer"), firstUsefulMs: null };
	if (!n.alignedWords.length || !times.has("stopGesture") || hasGap(take, "firstEndpoint", "firstUseful", "speechOnset", "speechEnd", "stopGesture")) {
		return { preview: measured(null, "Need observed display, endpoint, stop and shifted human alignment"), firstUsefulMs: null };
	}
	const stop = times.get("stopGesture");
	const endpoint = n.endpoints[0]?.ms;
	if (endpoint === undefined && (wire.state !== "pass" || !n.workerCleanExit)) {
		return { preview: measured(null, "No proof the endpoint observer witnessed the complete take"), firstUsefulMs: null };
	}
	const aligned = n.alignedWords.flatMap(({ word, endMs }) => tokens(word).map((token) => ({ word: token, endMs })));
	if (n.onsetMs >= n.endMs || !ordered(aligned, ({ endMs }) => endMs) || aligned.length < 2 ||
		aligned[0].endMs < n.onsetMs || aligned.at(-1).endMs > n.endMs) {
		return { preview: measured(false, "Invalid shifted alignment"), firstUsefulMs: null };
	}
	// Frame.text is the observed visible suffix, not an inferred worker partial.
	const visible = take.visible.map(({ ms: t, text }) => ({ t, line: draftLine(text) }));
	const progress = previewProgress(visible, aligned, n.onsetMs, Math.min(n.endMs, endpoint ?? Infinity, stop));
	if (!continuous && progress.firstCorrectMs !== null) return { preview: measured(true, "Observed adjacent spoken pair before cutoff"), firstUsefulMs: progress.firstCorrectMs };
	const relevance = scoreDraftTrace(visible.filter(({ t }) => t < stop), aligned, n.onsetMs, n.endMs);
	const pass = progress.firstCorrectMs !== null && progress.multiple && relevance.pass;
	const message = progress.firstCorrectMs === null ? "No correct adjacent spoken pair before first worker endpoint, speech end and stop" :
		!progress.multiple ? "Fewer than two advancing relevant revisions before cutoff" : !relevance.pass ? "Stale or irrelevant drafts at checkpoints" : "Early advancing preview and relevant clipped tail";
	return { preview: measured(pass, message), firstUsefulMs: progress.firstCorrectMs };
}

function draftLine(text) {
	const displayed = stripVTControlCharacters(text);
	return displayed.startsWith("Live: ") ? displayed : `Live: ${displayed}`;
}

function scoreTarget(take, negative) {
	if (take.trial.target === "none") return na("No receiver under test");
	// Violations are actionable even when other required observations are absent.
	if ([take.sentCount, take.queuedCount, take.staleInsertions, take.duplicateInsertions].some((x) => x > 0) ||
		(take.expectedTarget !== null && take.observedTarget !== null && take.expectedTarget !== take.observedTarget)) {
		return measured(false, "Wrong target, stale/duplicate insertion, send or queue");
	}
	if (take.expectedTarget === null || take.observedTarget === null || take.sentCount === null || take.queuedCount === null ||
		take.staleInsertions === null || take.duplicateInsertions === null || hasGap(take, "correctTarget")) return measured(null, "Need independently observed target and send/queue/insertion counts");
	const prefix = take.trial.prefix ?? "";
	if (negative) return measured(take.observedTarget === prefix && take.mutations.every(({ text }) => text === prefix), "Negative control must leave the target unchanged");
	if (!take.mutations.length || take.delivered === null || !wordsPresent(take.delivered)) return measured(null, "No actual receiver mutation or delivered words");
	const final = take.cleaned ?? take.raw;
	if (take.trial.processing === "off" && final !== null && take.delivered.trim() !== final.trim()) return measured(false, "Receiver content differs from the unprocessed final");
	const matches = take.mutations.filter(({ text }) => text === take.expectedTarget);
	const prefixWrites = take.mutations.every(({ text }, i) => text.startsWith(prefix) && take.expectedTarget.trimEnd().startsWith(text.trimEnd()) &&
		(!i || text.trimEnd().startsWith(take.mutations[i - 1].text.trimEnd())));
	return measured(take.observedTarget.startsWith(prefix) && take.observedTarget !== prefix && matches.length === 1 && prefixWrites &&
		take.mutations.at(-1).text === take.observedTarget && take.observedTarget.slice(prefix.length).trim() === take.delivered.trim(), "Correct observed receiver content exactly once, preserving prompt prefix");
}

function scoreStages(take, times) {
	const { trial: t, native: n } = take;
	if (!ordered(take.events) || times.size !== take.events.length || !ordered(take.visible) || !ordered(take.commits) || !ordered(take.mutations) ||
		(n && !ordered(n.endpoints))) return measured(false, "Expected unique events and observation-ordered trace times");
	if (times.has("trigger") && times.get("trigger") !== 0) return measured(false, "Trigger must anchor the take clock at 0 ms");
	const gaps = take.gaps.filter(({ stage, code }) => stage === null || code !== "unsupported" || stageApplies(stage, t, n?.route === "batch"));
	if (gaps.length) return measured(null, gaps.map(({ stage, code }) => `${stage ?? "take"}: ${code}`).join(", "));
	const negative = negativeFixtures.has(t.fixture);
	const required = ["trigger", "rawFinal"];
	if (n?.asrLoads > 0) required.push("modelLoaded");
	if (t.track !== "pcm") {
		required.push("firstSample", "readyCue", "stopGesture", "drained");
		if (!negative) required.push("speechOnset", "speechEnd");
	}
	if (t.target !== "none" && !negative) required.push("correctTarget");
	if (n?.route === "stream" && t.target === "pi-prompt" && !negative) required.push("firstCommit");
	const absent = required.filter((stage) => !times.has(stage));
	if (absent.length) return measured(null, `Missing observed ${absent.join(", ")}`);
	if (t.processing === "on" && !times.has("polishDone") && !times.has("hookDone")) return measured(null, "Missing requested processing completion evidence");
	const orderedStages = [["trigger", "rawFinal"], ["modelLoaded", "rawFinal"], ["trigger", "firstSample"], ["firstSample", "readyCue"], ["readyCue", "stopGesture"],
		["firstSample", "speechOnset"], ["speechOnset", "speechEnd"], ["speechEnd", "stopGesture"], ["stopGesture", "drained"], ["drained", "rawFinal"]];
	if (n?.route === "batch") orderedStages.push(["rawFinal", "correctTarget"]);
	if (orderedStages.some(([a, b]) => times.has(a) && times.has(b) && times.get(b) < times.get(a))) return measured(false, "Impossible capture or delivery stage order");
	if (n?.endpoints.length && times.has("firstEndpoint") && times.get("firstEndpoint") !== n.endpoints[0].ms) return measured(false, "First endpoint differs from the observed native endpoint clock");
	if (required.includes("firstCommit") && !take.commits.length) return measured(null, "Missing actual commit observer");
	if (times.has("firstCommit") && take.commits.length && times.get("firstCommit") !== take.commits[0].ms) return measured(false, "First commit differs from the actual editor trace");
	const target = take.mutations.find(({ text }) => text === take.expectedTarget);
	if (target && times.has("correctTarget") && times.get("correctTarget") !== target.ms) return measured(false, "Correct target time differs from the actual receiver trace");
	return measured(true, "Required trigger, capture, final and receiver stages observed");
}

function scorePcm(take) {
	const { native: n, trial: t } = take;
	if (!n || !t.pcmSha256 || take.pcmBytes === null || take.fedBytes === null || take.fedSha256 === null) return measured(null, "Need captured, closed and consumed PCM length/digest from the actual route");
	return measured(n.workerCleanExit && n.capturedSamples > 0 && n.closedSamples === n.capturedSamples && n.inputSamples === n.capturedSamples &&
		n.inputPcmSha256 === t.pcmSha256 && take.fedSha256 === t.pcmSha256 && take.pcmBytes === n.capturedSamples * 2 && take.fedBytes === take.pcmBytes,
	"Same complete PCM was captured, closed and consumed, and the worker exited cleanly");
}

function scoreLoads(take) {
	const { native: n, trial: t } = take;
	if (!n || n.asrCalls === null || n.asrLoads === null || n.vadLoads === null) return measured(null, "Missing native inference/model/VAD counts");
	const want = t.cache === "warm-model" ? 0 : 1;
	const vad = n.route === "stream" && t.build.vad && !/^(?:off|none|native|model)$/i.test(t.build.vad);
	return measured(n.asrLoads === want && (vad ? n.vadLoads === want : n.vadLoads <= want), "Native loads distinguish a fresh/idle reload from a reused model");
}

function scoreChunks(take) {
	const { native: n, trial: t } = take;
	if (!n) return measured(null, "Missing native endpoint/seam observer");
	const chunked = /^(?:chunk(?:ed|ing)?|on|1)(?:\b|$)/i.test(t.build.chunkPolicy ?? "");
	if (n.chunks === null && chunked && n.route === "batch") return measured(null, "Need actual chunk boundaries and seam finals");
	let cursor = 0;
	for (const { from, to } of n.chunks ?? []) {
		if (from !== cursor || to <= from || to > n.inputSamples) return measured(false, "Actual chunk boundaries do not cover contiguous consumed PCM");
		cursor = to;
	}
	if (n.chunks !== null && cursor !== n.inputSamples) return measured(false, "Chunk boundaries miss the end of consumed PCM");
	const finals = n.chunks ?? n.endpoints;
	return measured(!extraBoundaryRepeats(t.referenceText ?? "", finals.map(({ text }) => text)).length, "No spurious repeated words at chunk or endpoint boundaries");
}

function scoreNegatives(take) {
	const { native: n, trial: t } = take;
	if (!negativeFixtures.has(t.fixture)) return na("Speech fixture");
	const frames = [...take.visible, ...take.commits, ...(n?.endpoints ?? []), ...(n?.chunks ?? [])];
	const text = [take.raw, take.cleaned, take.replayed, take.delivered, ...frames.map(({ text }) => stripVTControlCharacters(text).replace(/^Live:\s*/u, ""))];
	if (text.some(wordsPresent)) return measured(false, "Spurious words on a negative control");
	const gaps = take.gaps.some(({ stage, code }) => stage === null || stage === "rawFinal" ||
		(["firstUseful", "firstCommit"].includes(stage) && !(n?.route === "batch" && code === "unsupported")));
	if (take.raw === null || gaps) return measured(null, "Negative-control text observer incomplete");
	return measured(true, "No visible, committed, final or delivered words");
}

function scoreSpeech(take, wer) {
	const { native: n, trial: t } = take;
	if (negativeFixtures.has(t.fixture)) return na("Negative control");
	if (take.missedOnset || take.missedTail || take.repeatErrors > 0) return measured(false, "Lost onset/tail or spurious repetition");
	if (!t.referenceText || take.raw === null) return measured(null, "Need human reference and observed raw final");
	if (!wordsPresent(take.raw) || (keywords[t.fixture] && !hasKeywords(take.raw, keywords[t.fixture]))) return measured(false, "Final lost required onset, tail or keywords");
	if (n?.asrCalls === 0) return measured(false, "Speech final reported without a native ASR call");
	if (t.task === "translate-en" && tokens(t.referenceText).join(" ") !== tokens(take.raw).join(" ")) return measured(null, "Independent English meaning review needed for a non-exact translation");
	if (t.fixture === "identifiers" && t.referenceText.normalize("NFC").toLowerCase().trim() !== take.raw.normalize("NFC").toLowerCase().trim()) {
		return measured(false, "Identifier/number control differs from the frozen literal transcript");
	}
	if (t.fixture === "jfk" || t.fixture === "continuous") {
		if (wer.wer > 0.2) return measured(false, "Raw WER exceeds 20%");
		if (n?.matchedClipRaw == null) return measured(null, "Need separate matched-PCM/weight whole-file raw comparator");
		if (wer.wer - wordErrors(t.referenceText, n.matchedClipRaw).wer > 0.1 + Number.EPSILON) return measured(false, "Raw WER exceeds matched clip by >10 percentage points");
	}
	if (t.track !== "pcm" && (take.missedOnset === null || take.missedTail === null || take.repeatErrors === null)) return measured(null, "Need onset, tail and repetition observation");
	return measured(true, "Raw accuracy and control keywords");
}

// Edit distance on Unicode graphemes (excluding whitespace); preserve numbers,
// punctuation and script so a normalization does not hide identifier errors.
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
function characters(text) {
	return [...graphemes.segment(text.normalize("NFC").toLowerCase())].map(({ segment }) => segment).filter((s) => !/^\s+$/u.test(s));
}

function characterErrors(reference, raw) {
	const left = characters(reference);
	const right = characters(raw);
	let row = Uint32Array.from({ length: right.length + 1 }, (_, i) => i);
	for (let i = 0; i < left.length; i++) {
		const next = new Uint32Array(row.length);
		next[0] = i + 1;
		for (let j = 0; j < right.length; j++) next[j + 1] = Math.min(row[j + 1] + 1, next[j] + 1, row[j] + Number(left[i] !== right[j]));
		row = next;
	}
	return { characters: left.length, errors: row.at(-1), cer: left.length ? row.at(-1) / left.length : null };
}

export function scoreTake(take) {
	validateTake(take);
	const { trial: t, native: n } = take;
	const times = eventMap(take);
	const comparableText = t.referenceText !== null && take.raw !== null;
	const wer = comparableText ? wordErrors(t.referenceText, take.raw) : null;
	const cer = comparableText ? characterErrors(t.referenceText, take.raw) : null;
	const wire = n?.route === "batch" ? (n.wire === null ? na("Batch route has no streaming transport") : measured(false, "Batch route must not claim stream wire")) :
		(n ? scoreWire(n.wire, n.capturedSamples, t.fixture === "overload") : measured(null, "No native route/transport trace"));
	const { preview, firstUsefulMs } = scorePreview(take, times, wire);
	// For native preview/endpoint, prefer actual trace replay over self-reported milestones.
	if (preview.state !== "not-applicable" && n) {
		times.delete("firstUseful");
		if (firstUsefulMs !== null) times.set("firstUseful", n.onsetMs + firstUsefulMs);
	}
	if (n) {
		times.delete("firstEndpoint");
		if (n.endpoints.length) times.set("firstEndpoint", n.endpoints[0].ms);
	}
	const gates = {
		outcome: measured(take.outcome === "completed" ? true : take.outcome === "unavailable" ? null : false, take.outcome),
		stages: scoreStages(take, eventMap(take)), pcm: scorePcm(take), wire, loads: scoreLoads(take), preview,
		idleMic: t.track === "pcm" ? na("Whole-file route does not use a microphone") :
			measured(take.idleMicOpen === null ? null : !take.idleMicOpen, "The capture source must not stay open while idle"),
		silenceCalls: t.fixture === "silence" ? measured(n?.asrCalls == null ? null : n.asrCalls === 0, "Digital silence requires zero native ASR calls") : na("Not digital silence"),
		negatives: scoreNegatives(take), speech: scoreSpeech(take, wer), seams: scoreChunks(take), target: scoreTarget(take, negativeFixtures.has(t.fixture)),
	};
	const values = Object.values(gates).map(({ state }) => state);
	return { status: values.includes("fail") ? "fail" : values.includes("unverified") ? "unverified" : "pass", gates, times, firstUsefulMs, wer, cer };
}

export function summarize(values) {
	return { count: values.length, finite: values.filter(Number.isFinite).length, median: nearestRank(values, 0.5), p95: nearestRank(values, 0.95) };
}

function latency(scored, band) {
	const { take, score } = scored;
	if (!take || take.outcome !== "completed" || hasGap(take, band.from, band.to)) return null;
	if (take.native?.route === "batch" && (previewStages.has(band.from) || previewStages.has(band.to))) return null;
	if (score.gates.stages.state === "fail") return null;
	const a = score.times.get(band.from);
	const b = score.times.get(band.to);
	return a !== undefined && b !== undefined && b >= a ? b - a : null;
}

function byKey(items, f) {
	const groups = new Map();
	for (const item of items) {
		const key = f(item);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(item);
	}
	return groups;
}
const interval = ({ from, to }) => `${from} → ${to}`;

function deriveCalibration(protocol) {
	const byCondition = byKey(protocol.calibration, ({ trial }) => conditionKey(trial));
	const result = new Map();
	for (const [key, takes] of byCondition) {
		const pairs = [];
		let complete = true;
		for (const group of byKey(takes, ({ trial }) => trial.pairId).values()) {
			const orderedTakes = group.slice().sort((a, b) => a.trial.repeatIndex - b.trial.repeatIndex);
			if (orderedTakes.length % 2) complete = false;
			for (let i = 1; i < orderedTakes.length; i += 2) pairs.push([orderedTakes[i - 1], orderedTakes[i]]);
		}
		const scored = pairs.map((pair) => pair.map((take) => ({ take, score: scoreTake(take) })));
		const bands = new Map();
		for (const band of protocol.toleranceMs) {
			const differences = scored.map(([a, b]) => {
				if (a.score.gates.pcm.state !== "pass" || b.score.gates.pcm.state !== "pass") return null;
				const ref = latency(a, band);
				const repeat = latency(b, band);
				return ref === null || repeat === null ? null : Math.abs(ref - repeat);
			});
			const stats = summarize(differences);
			bands.set(interval(band), { ...stats, usable: complete && stats.count > 0 && stats.finite === stats.count && Math.abs(stats.p95 - band.ms) < 1e-9 });
		}
		result.set(key, { takes: takes.length, bands });
	}
	return result;
}

export function validateFrozenCalibration(protocol) {
	const calibration = deriveCalibration(protocol);
	for (const band of protocol.toleranceMs) {
		if (![...calibration.values()].some(({ bands }) => bands.get(interval(band)).usable)) {
			throw new Error(`Frozen ${interval(band)} tolerance does not match a complete p95 reference/reference calibration`);
		}
	}
	return calibration;
}

function recordEntry(trial, take = null, ref = null) {
	return { trial: take?.trial ?? trial, planned: trial, take, ref, score: take ? scoreTake(take) : null };
}

function actualEvidence(entry) {
	const pinned = entry.planned.build;
	return entry.trial.rig.actualBackend !== "unknown" && entry.trial.rig.actualDevice !== null &&
		Boolean(entry.trial.rig.os && entry.trial.rig.arch && pinned.binarySha256 && pinned.commit && pinned.engineRevision && pinned.modelSha256) &&
		Boolean(entry.trial.pcmSha256 && entry.trial.referenceText !== null) && entry.planned.input !== "physical" &&
		!/(?:mock|scripted|simulated)/i.test(`${entry.trial.build.backend} ${entry.trial.build.engineRevision} ${entry.trial.rig.display}`);
}

function matchedArtifacts(a, b) {
	if (a.trial.panel !== "matched") return true;
	const left = a.trial.build;
	const right = b.trial.build;
	return ["modelSha256", "quant", "vad", "chunkPolicy"].every((k) => left[k] !== null && left[k] === right[k]);
}

function plannedCondition({ planned }) {
	return conditionKey(planned, false);
}

function plannedCohort(entry) {
	return canonicalKey([plannedCondition(entry), entry.planned.build]);
}

function plannedPair(entry) {
	return canonicalKey([plannedCondition(entry), entry.planned.pairId, entry.planned.repeatIndex]);
}

function uniqueByPair(group) {
	const map = new Map();
	let unique = true;
	for (const e of group) {
		const key = plannedPair(e);
		if (map.has(key)) unique = false;
		map.set(key, e);
	}
	return { map, unique };
}

function sameObservedCondition(a, b) {
	return conditionKey(a.trial) === conditionKey(b.trial) && a.trial.rig.actualBackend !== "unknown" && a.trial.rig.actualDevice !== null;
}

function accuracyNoWorse(a, b) {
	if (!b.take || b.take.outcome !== "completed") return a.take?.outcome !== "completed";
	if (a.take?.outcome !== "completed") return true;
	if (b.score.wer?.wer > a.score.wer?.wer || b.score.cer?.cer > a.score.cer?.cer) return false;
	if (a.take.delivered !== null && b.take.delivered === null) return false;
	if (a.take.delivered === null || b.take.delivered === null) return true;
	const ref = a.trial.referenceText;
	return ref !== null && !(wordErrors(ref, b.take.delivered).wer > wordErrors(ref, a.take.delivered).wer) &&
		!(characterErrors(ref, b.take.delivered).cer > characterErrors(ref, a.take.delivered).cer);
}

function stageApplies(stage, trial, batch) {
	if (previewStages.has(stage) && batch) return false;
	if (stage === "firstUseful") return trial.track !== "pcm" && trial.width !== null && trial.fixture === "continuous";
	if (stage === "firstCommit" || stage === "correctTarget") return trial.target !== "none" && !negativeFixtures.has(trial.fixture);
	if (stage === "speechOnset" || stage === "speechEnd") return trial.track !== "pcm" && !negativeFixtures.has(trial.fixture);
	if (["firstSample", "readyCue", "stopGesture", "drained"].includes(stage)) return trial.track !== "pcm";
	if (stage === "modelLoaded") return trial.cache !== "warm-model";
	if (stage === "polishDone" || stage === "hookDone") return trial.processing === "on";
	return true;
}

function compareCohort(refs, candidates, protocol, calibration, compatible) {
	const a = uniqueByPair(refs);
	const b = uniqueByPair(candidates);
	const pairKeys = new Set([...a.map.keys(), ...b.map.keys()]);
	const declared = [...pairKeys].filter((key) => a.map.has(key) && b.map.has(key)).map((key) => [a.map.get(key), b.map.get(key)]);
	const pairs = declared.filter(([r, c]) => sameObservedCondition(r, c) && compatible(r, c));
	const all = [...refs, ...candidates];
	const measuredRoutes = all.filter(({ take }) => take?.native);
	const everyBatch = measuredRoutes.length > 0 && measuredRoutes.every(({ take }) => take.native.route === "batch");
	const observedConditions = new Set(all.filter(({ take }) => take?.outcome === "completed").map((e) => conditionKey(e.trial)));
	const toReport = new Map(standardBands.map((band) => [interval(band), band]));
	for (const band of protocol.toleranceMs) toReport.set(interval(band), band);
	const key = observedConditions.size === 1 ? [...observedConditions][0] : null;
	const bands = [...toReport.values()].map((band) => {
		const previewNA = everyBatch && (previewStages.has(band.from) || previewStages.has(band.to));
		const applicable = stageApplies(band.from, all[0].trial, everyBatch) && stageApplies(band.to, all[0].trial, everyBatch);
		if (!applicable) return { band, applicable, previewNA };
		const rows = pairs.map(([r, c]) => [latency(r, band), latency(c, band)]);
		const reference = summarize(refs.map((e) => latency(e, band)));
		const candidate = summarize(candidates.map((e) => latency(e, band)));
		const delta = summarize(rows.filter(([r, c]) => r !== null && c !== null).map(([r, c]) => c - r));
		const frozen = calibration.get(key)?.bands.get(interval(band));
		return { band, reference, candidate, delta, frozen, applicable: true, pass: Boolean(frozen?.usable && reference.finite === reference.count && candidate.finite === candidate.count &&
			candidate.median <= reference.median + band.ms && candidate.p95 <= reference.p95 + band.ms) };
	});
	const unavailable = !a.unique || !b.unique || !pairs.length || declared.length !== pairKeys.size || pairs.length !== declared.length || observedConditions.size > 1;
	const invalid = all.some(({ score }) => score?.status === "fail") || pairs.some(([r, c]) => r.take && c.take && !accuracyNoWorse(r, c));
	const previewValues = candidates.filter(({ score }) => score && score.gates.preview.state !== "not-applicable").map((e) => e.score.firstUsefulMs);
	const slowDraft = previewValues.length > 0 && (nearestRank(previewValues, 0.5) > 3_000 || nearestRank(previewValues, 0.95) > 5_000);
	const incomplete = all.some((e) => e.score?.status !== "pass" || !actualEvidence(e)) || pairs.some(([r, c]) => !matchedArtifacts(r, c));
	const short = pairs.length < protocol.minimumTimed;
	const calibrated = bands.filter((row) => row.applicable && row.band.ms !== null);
	const missingBands = !calibrated.length || calibrated.some((row) => !row.frozen?.usable || row.reference.finite !== row.reference.count || row.candidate.finite !== row.candidate.count);
	const status = invalid ? "fail" : unavailable || incomplete ? "unavailable" : short ? "exploratory" : missingBands ? "unavailable" :
		calibrated.every(({ pass }) => pass) && !slowDraft ? "pass" : "fail";
	const reason = invalid ? "Observed functional/native or relative accuracy/success violation" : unavailable ? "Missing or ambiguous same-condition pairs" :
		incomplete ? "Missing required observed stages, gates, exact artifacts or actual device identity" : short ? `Fewer than ${protocol.minimumTimed} same-condition pairs` :
			missingBands ? "Missing applicable latency observations or independently frozen same-condition tolerance" : slowDraft ? "Draft latency exceeds fixed 3 s median / 5 s p95" :
				status === "fail" ? "Latency exceeds frozen reference tolerance" : "All observed gates and frozen timing bands passed";
	return { status, reason, pairs: pairs.length, planned: pairKeys.size, bands };
}

async function publicFile(root, name, protectedFiles) {
	validateEvidencePath(name);
	const path = await realpath(join(root, name));
	validateEvidencePath(relative(root, path).split(sep).join("/"));
	if (!(await stat(path)).isFile()) throw new Error(`${name}: evidence must be a regular file`);
	protectedFiles.add(path);
	return path;
}

function referenceKey({ file, line }) {
	return `${file}:${line}`;
}

async function readScorecard(root, baselineOnly, protectedFiles) {
	const rows = [];
	const traces = new Map();
	const evidence = new Set();
	const files = baselineOnly ? SCORECARD_INPUTS.slice(0, 1) : SCORECARD_INPUTS;
	for (let phaseFile = 0; phaseFile < files.length; phaseFile++) {
		const file = files[phaseFile];
		const path = await publicFile(root, file, protectedFiles);
		const source = await readJsonl(path, validateScorecardRow);
		if (!source.length) throw new Error(`${file}: expected at least one observed or explicitly unresolved row`);
		for (let i = 0; i < source.length; i++) {
			const row = source[i];
			const at = `${file}:${i + 1}`;
			if (row.phase !== phases[phaseFile]) throw new Error(`${at}: unexpected producing phase`);
			for (const name of row.evidence) {
				if (evidence.has(name)) continue;
				await publicFile(root, name, protectedFiles);
				evidence.add(name);
			}
			for (const ref of [...row.before, ...row.takes]) {
				if (!traces.has(ref.file)) traces.set(ref.file, await readJsonl(await publicFile(root, ref.file, protectedFiles), validateTake));
				if (!traces.get(ref.file)[ref.line - 1]) throw new Error(`${at}: unresolved B take ${referenceKey(ref)}`);
			}
			rows.push({ row, file, line: i + 1 });
		}
	}
	return { rows, traces };
}

function follow(ref, traces) {
	return traces.get(ref.file)[ref.line - 1];
}

function plannedMatches(trial, trials) {
	return trials.filter((plan) => isPlannedTake(plan, trial));
}

function mapBaseline(protocol, rows, traces) {
	const entries = new Map();
	const refs = new Set();
	const verified = new Set();
	const p1Files = new Set();
	for (const { row } of rows.filter(({ row }) => row.phase === 1)) {
		for (const ref of [...row.before, ...row.takes]) {
			p1Files.add(ref.file);
			if (row.check === "pass" && !["unverified", "blocked"].includes(row.label)) verified.add(referenceKey(ref));
		}
	}
	const evidence = [...p1Files].flatMap((file) => traces.get(file).map((_, i) => ({ file, line: i + 1 })));
	for (const ref of evidence) {
		const key = referenceKey(ref);
		const take = follow(ref, traces);
		const matches = plannedMatches(take.trial, protocol.trials);
		if (matches.length !== 1) throw new Error(`${key}: B evidence does not resolve to exactly one frozen P1 slot`);
		const slot = matches[0];
		if (entries.has(slot)) throw new Error(`${key}: multiple B records for the same frozen P1 slot`);
		entries.set(slot, recordEntry(slot, take, ref));
		refs.add(key);
	}
	return { entries: protocol.trials.map((slot) => entries.get(slot) ?? recordEntry(slot)), refs, verified };
}

function checkRowDimensions(row, trial, at) {
	for (const field of ["language", "task", "target", "cache", "fixture", "rig"]) {
		if (row[field] !== null && canonicalKey(row[field]) !== canonicalKey(trial[field])) throw new Error(`${at}: Q ${field} does not match the linked B observation`);
	}
	if (canonicalKey(row.build) !== canonicalKey(trial.build)) throw new Error(`${at}: Q build does not match the linked B observation`);
}

function phaseEntries(source, traces, baseline) {
	const { row } = source;
	const at = referenceKey(source);
	const takes = row.takes.map((ref) => {
		const take = follow(ref, traces);
		checkRowDimensions(row, take.trial, at);
		return recordEntry(take.trial, take, ref);
	});
	const referenceKeys = new Set(row.before.map(referenceKey));
	for (const key of referenceKeys) if (!baseline.refs.has(key)) throw new Error(`${at}: before must reference a frozen P1 take`);
	const cohorts = new Set(baseline.entries.filter(({ ref }) => ref && referenceKeys.has(referenceKey(ref))).map(plannedCohort));
	// Use the frozen denominator, not just the subset of reference repeats a
	// producer linked. A dropped failed or slow pair cannot turn into a pass.
	const before = baseline.entries.filter((entry) => cohorts.has(plannedCohort(entry)));
	for (const candidate of takes) {
		const { build, product } = candidate.trial;
		const proposed = before.map(({ planned }) => ({ ...planned, build, product })).filter((plan) => isPlannedTake(plan, candidate.trial));
		if (proposed.length === 1) candidate.planned = proposed[0];
	}
	return { takes, before, completeReferences: before.every(({ ref }) => ref && referenceKeys.has(referenceKey(ref))) };
}

const text = (s) => String(s ?? "—").replace(/[&<>|[\]`\\*]/gu, (c) => `&#${c.codePointAt(0)};`).replace(/[\u0000-\u001f\u007f]/gu, (c) => c === "\n" ? " ↵ " : " ");
const linkPath = (p) => p.split("/").map(encodeURIComponent).join("/").replace(/[()]/gu, (c) => c === "(" ? "%28" : "%29");
const link = (p, label = p) => `[${text(label)}](./${linkPath(p)})`;
const takeLink = ({ file, line }) => `[${text(referenceKey({ file, line }))}](./${linkPath(file)}#L${line})`;
const numeric = (n) => !Number.isFinite(n) ? "∞" : String(Number(n.toFixed(3)));
const tally = ({ median, p95, finite, count }) => `${numeric(median)} / ${numeric(p95)} (${finite}/${count})`;
const joinCells = (cells) => `| ${cells.join(" | ")} |`;

function conditionDescription(t) {
	const { rig: r } = t;
	const device = r.actualDevice ? [r.actualDevice.id, r.actualDevice.label].filter((v) => v !== null).join(" / ") : "unobserved";
	return [t.track, t.panel, t.fixture, t.language, t.task, t.target, t.width && `${t.width} columns`, t.cache, `disk ${t.disk}`, t.load,
		`processing ${t.processing}`, t.input, t.gesture, r.os, r.arch, r.display, r.cpu, r.gpu, r.driver, r.hostVersion,
		`backend ${r.actualBackend}`, `actual device ${device}`, r.requestedDevice && `requested ${r.requestedDevice}`, r.threads && `${r.threads} threads`, r.mic].filter(Boolean).join(" · ");
}

function buildName(b) {
	return [b.product, b.tag, b.commit, b.backend, b.engineRevision, b.modelFile, b.modelRevision, b.quant, b.vad, b.chunkPolicy].filter(Boolean).join(" · ");
}

function renderComparisons(lines, refs, candidates, protocol, calibration, unresolved = () => false, compatible = () => true) {
	const groups = byKey([...refs, ...candidates], plannedCondition);
	for (const [key, entries] of groups) {
		const left = refs.filter((e) => plannedCondition(e) === key);
		const right = candidates.filter((e) => plannedCondition(e) === key);
		const result = compareCohort(left, right, protocol, calibration, compatible);
		const status = result.status === "pass" && entries.some(unresolved) ? "unavailable" : result.status;
		lines.push(`- **${status}** — ${text(conditionDescription(entries[0].trial))} — ${result.pairs}/${result.planned} paired slots. ${text(status !== result.status ? "Functional/producer evidence is unresolved for this measurement." : result.reason)}`);
		const table = [];
		for (const { band, reference, candidate, delta, frozen, applicable, previewNA } of result.bands) {
			if (previewNA) table.push(joinCells([interval(band), "N/A (batch)", "N/A (batch)", "N/A (batch)", "—"]));
			else if (applicable && (band.ms !== null || reference.finite || candidate.finite)) {
				table.push(joinCells([interval(band), tally(reference), tally(candidate), tally({ ...delta, count: result.pairs }),
					frozen?.usable ? `${numeric(band.ms)} (${frozen.finite}/${frozen.count})` : "unavailable"]));
			}
		}
		if (table.length) lines.push("", "| Interval (ms) | Reference median / p95 (finite/slots) | Candidate median / p95 (finite/slots) | Paired Δ median / p95 (finite/pairs) | Frozen tolerance (calibration n) |",
			"| --- | --- | --- | --- | --- |", ...table, "");
	}
}

function renderP1Comparisons(lines, baseline, protocol, calibration) {
	const [reference, ...candidates] = protocol.products;
	const isUnresolved = ({ ref }) => !ref || !baseline.verified.has(referenceKey(ref));
	const buildKey = ({ planned }) => canonicalKey(planned.build);
	const plans = byKey(baseline.entries.filter(({ planned }) => planned.panel === "default"), buildKey);
	const referenceKeyForBuild = canonicalKey(reference);
	const refs = plans.get(referenceKeyForBuild) ?? [];
	for (const build of candidates) {
		const entries = plans.get(canonicalKey(build)) ?? [];
		if (!refs.length && !entries.length) continue;
		lines.push(`**${text(buildName(reference))} → ${text(buildName(build))}**`, "");
		renderComparisons(lines, refs, entries, protocol, calibration, isUnresolved);
		lines.push("");
	}

	const matched = baseline.entries.filter(({ planned }) => planned.panel === "matched");
	for (const cohort of byKey(matched, (entry) => canonicalKey([plannedCondition(entry), entry.planned.pairId])).values()) {
		const byBuild = byKey(cohort, buildKey);
		const [first, ...others] = protocol.products.filter((build) => byBuild.has(canonicalKey(build)));
		const firstKey = canonicalKey(first);
		// V1 calibration is collected only for the first global build. A
		// different matched reference can show observed deltas but not use it.
		const frozen = firstKey === referenceKeyForBuild ? calibration : new Map();
		for (const candidate of others) {
			lines.push(`**${text(buildName(first))} → ${text(buildName(candidate))}** — ${text(cohort[0].planned.pairId)}`, "");
			renderComparisons(lines, byBuild.get(firstKey), byBuild.get(canonicalKey(candidate)), protocol, frozen, isUnresolved);
			lines.push("");
		}
	}
	if (!candidates.length) lines.push("No planned candidate build; reference-only observations do not decide parity.", "");
}

function renderCohorts(lines, entries) {
	const groups = byKey(entries, plannedCohort);
	lines.push("| Observed condition | Product / build / model | Slots | Recorded | No record | Completed / failed / timeout / lost / unavailable | WER median / p95 | CER median / p95 | Compute ms median / p95 | Compute / audio median / p95 | Lag samples median / p95 | Peak RSS bytes median / p95 | Idle RSS bytes median / p95 |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const group of groups.values()) {
		const totals = Run.map((outcome) => group.filter(({ take }) => take?.outcome === outcome).length);
		const recorded = totals.reduce((sum, n) => sum + n, 0);
		const statOf = (f) => tally(summarize(group.map(f)));
		const conditions = [...new Set(group.map(({ trial }) => conditionDescription(trial)))].join(" / ");
		const builds = [...new Set(group.map(({ trial }) => buildName(trial.build)))].join(" / ");
		lines.push(joinCells([text(conditions), text(builds), group.length, recorded,
			group.length - recorded, totals.join(" / "), statOf(({ score }) => score?.wer?.wer), statOf(({ score }) => score?.cer?.cer),
			statOf(({ take }) => take?.computeMs), statOf(({ take }) => take?.computeMs != null && take.audioMs > 0 ? take.computeMs / take.audioMs : null),
			statOf(({ take }) => take?.peakLagSamples), statOf(({ take }) => take?.peakRssBytes), statOf(({ take }) => take?.idleRssBytes)]));
	}
	lines.push("");
	const timing = [];
	for (const group of groups.values()) {
		for (const band of standardBands) {
			const stats = summarize(group.map((e) => latency(e, band)));
			if (stats.finite) timing.push(joinCells([text(conditionDescription(group[0].trial)), text(buildName(group[0].trial.build)), interval(band), tally(stats)]));
		}
	}
	if (timing.length) lines.push("| Planned cohort | Build | Observed interval (ms) | Median / p95 (finite/slots) |", "| --- | --- | --- | --- |", ...timing, "");
}

function renderTakes(lines, entries) {
	lines.push("| Slot and evidence | Product / outcome | Native / required gates | WER (S/D/I) / CER | Reference / raw / cleaned / replayed / delivered | Last visible draft | Expected / observed target |",
		"| --- | --- | --- | --- | --- | --- | --- |");
	for (const { trial, take, score, ref } of entries) {
		const gate = score ? Object.entries(score.gates).filter(([, { state }]) => state !== "pass").map(([name, { state, message }]) => `${name}: ${state} (${message})`) : ["No B record for this frozen slot"];
		if (take) gate.push(...take.gaps.map(({ stage, code, detail }) => `${stage ?? "take"}: ${code} — ${detail}`));
		const wer = score?.wer;
		const cer = score?.cer;
		const error = `${wer?.wer != null ? numeric(wer.wer) : "—"} (${wer ? `${wer.substitutions}/${wer.deletions}/${wer.insertions}` : "—"}) / ${cer?.cer != null ? numeric(cer.cer) : "—"}`;
		const observed = [take?.raw, take?.cleaned, take?.replayed, take?.delivered];
		lines.push(joinCells([`${text(trial.pairId)} #${trial.repeatIndex} ${ref ? takeLink(ref) : ""}`.trim(),
			`${text(trial.product)} / ${text(take?.outcome ?? "not recorded")}`, [text(score?.status), ...gate.map(text)].join(" · "), error,
			[trial.referenceText, ...observed].map(text).join(" / "), text(take?.visible.findLast(({ text }) => text.trim())?.text),
			[take?.expectedTarget, take?.observedTarget].map(text).join(" / ")]));
	}
	lines.push("");
}

function renderRecovery(lines, entries) {
	const indexed = new Map(entries.map((entry) => [referenceKey(entry.ref), entry]));
	for (const { take, ref } of entries) {
		if (take.outcome !== "failed" && take.outcome !== "lost") continue;
		const next = indexed.get(referenceKey({ file: ref.file, line: ref.line + 1 }));
		const sameArtifact = next && canonicalKey(next.trial.build) === canonicalKey(take.trial.build) &&
			canonicalKey(next.trial.rig) === canonicalKey(take.trial.rig) && take.trial.rig.actualDevice !== null;
		const suppressed = take.sentCount === 0 && take.queuedCount === 0 && take.mutations.length === 0 && !wordsPresent(take.delivered);
		const observation = sameArtifact && suppressed && next.score.status === "pass" ? `no delivery on failure; next take met recorded gates (${takeLink(next.ref)})` :
			"unverified recovery: need no failed-take output and the next observed success under the same artifact and actual rig";
		lines.push(`- Process recovery evidence ${takeLink(ref)}: ${observation}. This is not a timed pass.`);
	}
}

function renderScorecard(lines, rows) {
	lines.push("## Functional scorecard (Q)", "", "| Phase / feature | Build / actual conditions | Check | Evidence label | Reason / evidence needed | Direct and take evidence |",
		"| --- | --- | --- | --- | --- | --- |");
	for (const { row, file, line } of rows) {
		const device = row.rig?.actualDevice;
		const condition = [row.rig?.os, row.rig?.arch, row.rig?.display, row.rig?.actualBackend,
			device ? [device.id, device.label].filter(Boolean).join(" / ") : "actual device —", row.rig?.requestedDevice, row.language,
			row.task, row.target, row.cache, row.fixture, row.provider].filter(Boolean).join(" · ");
		lines.push(joinCells([`${row.phase} / ${row.feature}`, `${text(buildName(row.build))} · ${text(condition)}`, row.check, row.label,
			text(row.reason), [takeLink({ file, line }), ...row.evidence.map((p) => link(p)), ...row.before.map(takeLink), ...row.takes.map(takeLink)].join(", ")]));
	}
	lines.push("");
}

function renderCalibration(lines, protocol, calibration) {
	lines.push("## Frozen calibration", "", `Plan: ${link(manifestName)}. UTC: ${text(protocol.createdUtc)}. Minimum ${protocol.minimumTimed} pairs per timed condition.`,
		"Reference/reference tolerance is the nearest-rank p95 absolute paired difference in milliseconds. No candidate inputs enter calibration.", "");
	if (!protocol.calibration.length || !protocol.toleranceMs.length) {
		lines.push("No frozen independent calibration; no timed parity decision is available.", "");
		return;
	}
	lines.push("| Observed condition | Reference takes | Interval (ms) | Median / p95 (finite/pairs) | Frozen tolerance |");
	lines.push("| --- | --- | --- | --- | --- |");
	const example = new Map(protocol.calibration.map(({ trial }) => [conditionKey(trial), trial]));
	for (const [key, { takes, bands }] of calibration) {
		for (const band of protocol.toleranceMs) {
			const stats = bands.get(interval(band));
			lines.push(joinCells([text(conditionDescription(example.get(key))), takes, interval(band), tally(stats), stats.usable ? numeric(band.ms) : "unavailable"]));
		}
	}
	lines.push("");
}

export async function generateReport(root, { baselineOnly = false } = {}) {
	const base = await realpath(root);
	const protectedFiles = new Set();
	const protocol = await readJson(await publicFile(base, manifestName, protectedFiles), validateProtocol);
	const calibration = validateFrozenCalibration(protocol);
	const { rows, traces } = await readScorecard(base, baselineOnly, protectedFiles);
	const baseline = mapBaseline(protocol, rows, traces);
	const lines = [baselineOnly ? "# Handy transfer — frozen P1 baseline" : "# Handy transfer — combined scorecard", "",
		"Generated from public B/Q evidence. Evidence links are relative to the bundle root. Functional checks and measured parity are independent; missing latency contributes ∞. Δ is candidate minus reference on finite observed pairs only.", ""];
	renderCalibration(lines, protocol, calibration);
	renderScorecard(lines, rows);
	lines.push("## P1 planned denominator and observations", "");
	renderCohorts(lines, baseline.entries);
	lines.push("### P1 comparison", "");
	renderP1Comparisons(lines, baseline, protocol, calibration);
	renderTakes(lines, baseline.entries);
	for (const source of rows.filter(({ row }) => row.phase > 1)) {
		const { row } = source;
		lines.push(`## P${row.phase} ${row.feature} — ${takeLink(source)}`, "");
		const { before, takes, completeReferences } = phaseEntries(source, traces, baseline);
		if (takes.length) {
			renderCohorts(lines, takes);
			renderTakes(lines, takes);
			if (row.phase === 4) renderRecovery(lines, takes);
		}
		const compatible = (ref, candidate) => row.phase !== 2 || ["product", "backend", "modelRevision", "modelFile", "modelSha256", "quant", "vad", "chunkPolicy"]
			.every((key) => ref.trial.build[key] === candidate.trial.build[key]);
		if (before.length) renderComparisons(lines, before, takes, protocol, calibration, () => !completeReferences || row.check !== "pass" || ["blocked", "unverified"].includes(row.label), compatible);
		else lines.push(`Measured comparison: **unavailable** — ${text(row.reason ?? "No linked same-condition frozen reference and candidate traces; functional evidence is not a timing result.")}`, "");
	}
	return { markdown: `${lines.join("\n").trimEnd()}\n`, protectedFiles };
}

export async function writeTransferReport(root, output, options) {
	const { markdown, protectedFiles } = await generateReport(root, options);
	const dest = resolve(await realpath(dirname(output)), basename(output));
	const name = basename(dest);
	if (protectedFiles.has(dest) || name === "transfer-local.json" || dest === fileURLToPath(new URL("results.md", import.meta.url))) {
		throw new Error("Refusing to overwrite benchmark inputs, historical native results or the local provisioning sidecar");
	}
	if ((name === "transfer-baseline.md" && !options?.baselineOnly) || (name === "transfer-results.md" && options?.baselineOnly)) {
		throw new Error("Choose the report destination that matches the requested baseline-only or combined mode");
	}
	const existing = await lstat(dest).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
	if (existing && !existing.isFile()) throw new Error("Report destination must be a regular file, not a symlink or directory");
	const work = await mkdtemp(join(dirname(dest), ".transfer-report-"));
	try {
		const temp = join(work, "report.md");
		await writeFile(temp, markdown, "utf8");
		await rename(temp, dest);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}
