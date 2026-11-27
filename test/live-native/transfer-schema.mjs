// Public benchmark V1 (B), scorecard (Q), and the private provisioning format.
import { isAbsolute, posix } from "node:path";
import { readFile } from "node:fs/promises";

export const Product = Object.freeze(["handy-0102", "micme-041", "micme-70ad138", "micme-current"]);
export const Track = Object.freeze(["pcm", "paced", "destination"]);
export const Panel = Object.freeze(["default", "matched"]);
export const Fixture = Object.freeze(["jfk", "continuous", "overload", "short", "quiet", "pause", "repeat", "silence", "noise", "immediate", "french", "identifiers", "nonlatin", "translation"]);
export const Stage = Object.freeze(["trigger", "modelLoaded", "firstSample", "readyCue", "speechOnset", "speechEnd", "firstUseful", "firstEndpoint", "firstCommit", "stopGesture", "drained", "rawFinal", "polishDone", "hookDone", "correctTarget"]);
export const Run = Object.freeze(["completed", "failed", "timeout", "lost", "unavailable"]);
export const Gap = Object.freeze(["unsupported", "missing-input", "identity-mismatch", "unsafe-instance", "no-observer", "missing-host", "missing-permission", "no-result", "canceled"]);
export const Feature = Object.freeze(["BASE", "C1", "C2", "C3", "C4", "M1", "M2", "M3", "M4", "M5", "M6", "L1", "L2", "L3", "H1", "H2", "F1", "F2", "T1", "T2", "A2", "A4"]);
export const EvidenceLabel = Object.freeze(["existing-verified", "adapted-verified", "desktop-only-verified", "blocked", "unverified"]);
export const Check = Object.freeze(["pass", "fail", "blocked", "unverified"]);
export const Provider = Object.freeze(["local-openai", "custom-openai", "custom-anthropic", "openai", "anthropic", "groq", "cerebras", "openrouter", "zai", "bedrock-mantle", "apple-device"]);

const Task = ["transcribe", "translate-en"];
const Target = ["pi-prompt", "external-editor", "none"];
const Cache = ["cold-process", "warm-model", "idle-reload"];
const Compute = ["cpu", "metal", "vulkan", "unknown"];
const Negative = ["silence", "noise", "immediate"];

function invalid(at, expected) {
	throw new TypeError(`${at}: expected ${expected}`);
}

const string = (v, p) => { if (typeof v !== "string" || v.includes("\0")) invalid(p, "a string without NUL"); };
const nonempty = (v, p) => { string(v, p); if (!v.trim()) invalid(p, "a nonempty string"); };
const number = (v, p) => { if (!Number.isFinite(v)) invalid(p, "a finite number"); };
const nonnegative = (v, p) => { number(v, p); if (v < 0) invalid(p, "a nonnegative number"); };
const count = (v, p) => { if (!Number.isSafeInteger(v) || v < 0) invalid(p, "a nonnegative safe integer"); };
const positive = (v, p) => { count(v, p); if (v === 0) invalid(p, "a positive safe integer"); };
const bool = (v, p) => { if (typeof v !== "boolean") invalid(p, "a boolean"); };
const sha256 = (v, p) => { if (typeof v !== "string" || !/^[\da-f]{64}$/.test(v)) invalid(p, "a lowercase SHA-256 digest"); };
const oneOf = (values) => (v, p) => { if (!values.includes(v)) invalid(p, values.join(" | ")); };
const nullable = (check) => (v, p) => { if (v !== null) check(v, p); };
const list = (check) => (v, p) => {
	if (!Array.isArray(v)) invalid(p, "an array");
	for (let i = 0; i < v.length; i++) check(v[i], `${p}[${i}]`);
};

function record(shape) {
	return (v, p = "value") => {
		if (v === null || typeof v !== "object" || Array.isArray(v)) invalid(p, "an object");
		for (const key of Object.keys(v)) if (!Object.hasOwn(shape, key)) invalid(`${p}.${key}`, "no extra field");
		for (const [key, check] of Object.entries(shape)) {
			if (!Object.hasOwn(v, key)) invalid(`${p}.${key}`, "a field (use null for unobserved values)");
			check(v[key], `${p}.${key}`);
		}
		return v;
	};
}

// Paths in public manifests and reports are portable, canonical bundle names.
export function validateEvidencePath(v, p = "evidence path") {
	nonempty(v, p);
	if (/[\\:%\u0000-\u001f\u007f]/u.test(v) || posix.isAbsolute(v) || v.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) || v.split("/").at(-1) === "transfer-local.json") {
		invalid(p, "a public relative path inside the bundle (not the local sidecar)");
	}
	return v;
}

const utc = (v, p) => {
	if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v)) ||
		new Date(v).toISOString() !== v.replace(/(?<!\.\d{3})Z$/, ".000Z")) invalid(p, "an ISO-8601 UTC timestamp");
};

const device = record({ id: nullable(nonempty), label: nullable(nonempty) });
const observedDevice = nullable((v, p) => { device(v, p); if (v.id === null && v.label === null) invalid(p, "a runtime id or label"); });
export const validateRig = record({
	os: nullable(nonempty), arch: nullable(nonempty), display: nullable(string), cpu: nullable(string), gpu: nullable(string), driver: nullable(string),
	actualBackend: oneOf(Compute), actualDevice: observedDevice, requestedDevice: nullable(string), threads: nullable(positive), mic: nullable(string), hostVersion: nullable(string),
});
export const validateBuild = record({
	product: oneOf(Product), tag: nullable(string), commit: nullable(string), binarySha256: nullable(sha256), engineRevision: nullable(string),
	backend: nullable(string), modelRevision: nullable(string), modelFile: nullable(validateEvidencePath), modelSha256: nullable(sha256),
	quant: nullable(string), vad: nullable(string), chunkPolicy: nullable(string),
});
const trial = record({
	version: oneOf([1]), pairId: nonempty, repeatIndex: count, product: oneOf(Product), track: oneOf(Track), panel: oneOf(Panel),
	fixture: oneOf(Fixture), pcmSha256: nullable(sha256), referenceText: nullable(string), language: nullable(nonempty), task: oneOf(Task),
	rig: validateRig, build: validateBuild, width: oneOf([40, 80, null]), target: oneOf(Target), prefix: nullable(string), cache: oneOf(Cache),
	disk: oneOf(["cold-proven", "cached", "unknown"]), load: oneOf(["idle", "contended"]), processing: oneOf(["off", "on"]),
	input: oneOf(["file", "loopback", "physical"]), gesture: oneOf(["toggle", "hold-release", "none"]),
});

export function validateTrial(v, p = "trial") {
	trial(v, p);
	if (v.build.product !== v.product) invalid(`${p}.build.product`, "the trial product");
	if (v.input === "physical" && (v.referenceText !== null || v.prefix !== null)) invalid(p, "no private reference or prompt text from physical input");
	if (v.referenceText && Negative.includes(v.fixture)) invalid(`${p}.referenceText`, "an empty or null reference for a negative control");
	return v;
}

const event = record({ stage: oneOf(Stage), ms: number });
const frame = record({ ms: number, text: string });
const missing = record({ stage: nullable(oneOf(Stage)), code: oneOf(Gap), detail: nonempty });
const wireVariants = new Map([
	["feed", record({ kind: oneOf(["feed"]), from: count, through: count, catchUp: bool })],
	["ack", record({ kind: oneOf(["ack"]), through: count })],
	["finish", record({ kind: oneOf(["finish"]) })],
	["done", record({ kind: oneOf(["done"]), through: count })],
]);
const wire = (v, p) => {
	const check = wireVariants.get(v?.kind);
	if (!check) invalid(p, "one feed, ack, finish or done wire observation");
	check(v, p);
};
const native = record({
	route: oneOf(["stream", "batch"]), asrCalls: nullable(count), asrLoads: nullable(count), vadLoads: nullable(count),
	capturedSamples: count, closedSamples: count, inputSamples: count, inputPcmSha256: sha256, wire: nullable(list(wire)),
	endpoints: list(frame), chunks: nullable(list(record({ from: count, to: count, text: string }))), matchedClipRaw: nullable(string),
	alignedWords: list(record({ word: nonempty, endMs: number })), onsetMs: number, endMs: number, workerCleanExit: bool,
});
const optionalCount = nullable(count);
const optionalText = nullable(string);
const take = record({
	trial: validateTrial, native: nullable(native), outcome: oneOf(Run), gaps: list(missing), events: list(event), visible: list(frame),
	commits: list(frame), mutations: list(frame), expectedTarget: optionalText, observedTarget: optionalText, raw: optionalText,
	cleaned: optionalText, replayed: optionalText, delivered: optionalText, sentCount: optionalCount, queuedCount: optionalCount,
	pcmBytes: optionalCount, fedBytes: optionalCount, fedSha256: nullable(sha256), computeMs: nullable(nonnegative), audioMs: nullable(nonnegative),
	peakLagSamples: optionalCount, peakRssBytes: optionalCount, idleRssBytes: optionalCount, idleMicOpen: nullable(bool), missedOnset: nullable(bool),
	missedTail: nullable(bool), repeatErrors: optionalCount, staleInsertions: optionalCount, duplicateInsertions: optionalCount,
});

export function validateTake(v, p = "take") {
	take(v, p);
	if (v.outcome !== "completed" && !v.gaps.length) invalid(`${p}.gaps`, "a reason for noncompletion");
	if (v.trial.input === "physical") {
		if ([v.expectedTarget, v.observedTarget, v.raw, v.cleaned, v.replayed, v.delivered].some((s) => s !== null) ||
			v.visible.length || v.commits.length || v.mutations.length || v.native?.alignedWords.length || v.native?.endpoints.length ||
			v.native?.chunks != null || v.native?.matchedClipRaw != null) invalid(p, "no saved transcript or editor text from physical input");
	}
	return v;
}

const tolerance = record({ from: oneOf(Stage), to: oneOf(Stage), ms: nonnegative });
const protocol = record({ version: oneOf([1]), products: list(validateBuild), trials: list(validateTrial), calibration: list(validateTake),
	toleranceMs: list(tolerance), minimumTimed: oneOf([20]), createdUtc: utc });

export function canonicalKey(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalKey(value[k])}`).join(",")}}`;
	return JSON.stringify(value);
}

// Build, product and the runtime's observation of binding are not planned input settings.
// Actual backend + device still participate in the comparison key used by the scorer.
export function conditionKey(t, observed = true) {
	const settings = { ...t, rig: { ...t.rig } };
	for (const key of ["version", "pairId", "repeatIndex", "product", "build"]) delete settings[key];
	if (!observed) for (const key of ["actualBackend", "actualDevice", "hostVersion"]) delete settings.rig[key];
	return canonicalKey(settings);
}

export function pairKey(t) {
	return canonicalKey([conditionKey(t), t.pairId, t.repeatIndex]);
}

export function slotKey(t) {
	return canonicalKey([t.build, pairKey(t)]);
}

export function isPlannedTake(planned, observed) {
	if (planned.product !== observed.product || planned.pairId !== observed.pairId || planned.repeatIndex !== observed.repeatIndex ||
		conditionKey({ ...planned, rig: observed.rig }) !== conditionKey(observed)) return false;
	for (const [key, value] of Object.entries(planned.build)) if (value !== null && value !== observed.build[key]) return false;
	for (const [key, value] of Object.entries(planned.rig)) {
		if (value !== null && (key !== "actualBackend" || value !== "unknown") && canonicalKey(value) !== canonicalKey(observed.rig[key])) return false;
	}
	return true;
}

export function validateProtocol(v, p = "protocol") {
	protocol(v, p);
	if (!v.products.length || !v.trials.length) invalid(p, "declared builds and planned trials");
	const builds = new Set(v.products.map(canonicalKey));
	if (builds.size !== v.products.length) invalid(`${p}.products`, "unique build identities");
	const slots = new Set();
	const bands = new Set();
	for (const t of v.trials) {
		if (!builds.has(canonicalKey(t.build))) invalid(`${p}.trials`, "builds frozen in products");
		const key = slotKey(t);
		if (slots.has(key)) invalid(`${p}.trials`, "one slot per build, condition, pair and repeat");
		slots.add(key);
	}
	const calibrationSlots = new Set();
	for (const { trial: t } of v.calibration) {
		if (canonicalKey(t.build) !== canonicalKey(v.products[0])) invalid(`${p}.calibration`, "only the first (reference) build");
		const key = slotKey(t);
		if (calibrationSlots.has(key)) invalid(`${p}.calibration`, "one reference observation per condition, pair and repeat (duplicate calibration slot)");
		calibrationSlots.add(key);
	}
	for (const { from, to } of v.toleranceMs) {
		const key = `${from}/${to}`;
		if (from === to || bands.has(key)) invalid(`${p}.toleranceMs`, "unique intervals with distinct endpoints");
		bands.add(key);
	}
	return v;
}

const takeRef = record({ file: validateEvidencePath, line: positive });
const scorecardRow = record({
	version: oneOf([1]), phase: oneOf([1, 2, 3, 4, 5, 6, 7, 8]), feature: oneOf(Feature), build: validateBuild, rig: nullable(validateRig),
	language: nullable(nonempty), task: nullable(oneOf(Task)), target: nullable(oneOf(Target)), cache: nullable(oneOf(Cache)),
	fixture: nullable(oneOf(Fixture)), provider: nullable(oneOf(Provider)), check: oneOf(Check), label: oneOf(EvidenceLabel),
	reason: nullable(nonempty), evidence: list(validateEvidencePath), takes: list(takeRef), before: list(takeRef),
});

export function validateScorecardRow(v, p = "scorecard row") {
	scorecardRow(v, p);
	const unresolved = ["blocked", "unverified"];
	if ((unresolved.includes(v.check) || unresolved.includes(v.label)) && !v.reason) invalid(`${p}.reason`, "a specific gap and the evidence needed to resolve it");
	if (!unresolved.includes(v.label) && !v.evidence.length && !v.takes.length) invalid(p, "direct evidence for a verified row");
	if (v.before.length && !v.takes.length) invalid(`${p}.before`, "candidate traces for frozen comparison references");
	for (const key of ["before", "takes"]) {
		if (new Set(v[key].map(canonicalKey)).size !== v[key].length) invalid(`${p}.${key}`, "distinct trace references");
	}
	return v;
}

const absolutePath = (v, p) => { nonempty(v, p); if (!isAbsolute(v)) invalid(p, "an absolute local path"); };
const localPath = nullable(absolutePath);
const localHash = nullable(sha256);
const local = record({
	assetsDir: localPath, piBinary: localPath, tagCheckout: localPath, historicalCheckout: localPath, currentCheckout: localPath,
	backendFiles: list(record({ product: oneOf(Product), workerFile: localPath, clipFile: localPath, streamFile: localPath,
		workerSha256: localHash, clipSha256: localHash, streamSha256: localHash })),
	handyBinary: localPath, handyModelFiles: list(record({ catalogId: nonempty, file: absolutePath, sha256 })),
	whisperModelFiles: list(record({ name: nonempty, file: absolutePath, sha256 })),
	recognizerFile: localPath, recognizerSha256: localHash,
	engineModelFiles: list(record({ variantId: nonempty, blobPath: validateEvidencePath, file: absolutePath, sha256 })),
	vadFile: localPath, workDir: localPath,
});

export function validateLocal(v, p = "local sidecar") {
	// Engine-only inputs are optional on the original Whisper path.
	const checked = local({ recognizerFile: null, recognizerSha256: null, engineModelFiles: [], ...v }, p);
	const ids = { backendFiles: (x) => x.product, handyModelFiles: (x) => x.catalogId, whisperModelFiles: (x) => x.name,
		engineModelFiles: (x) => canonicalKey([x.variantId, x.blobPath]) };
	for (const [field, key] of Object.entries(ids)) {
		if (new Set(checked[field].map(key)).size !== checked[field].length) invalid(`${p}.${field}`, "unique provisioning entries");
	}
	return checked;
}

export async function readJson(path, validate) {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
	let value;
	try { value = JSON.parse(text); } catch { throw new TypeError(`${path}: invalid JSON`); }
	return validate(value, path);
}

export async function readJsonl(path, validate) {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
	if (!text) return [];
	return text.replace(/\r?\n$/, "").split(/\r?\n/).map((line, i) => {
		const at = `${path}:${i + 1}`;
		let value;
		try { value = JSON.parse(line); } catch { throw new TypeError(`${at}: expected one JSON object per line`); }
		return validate(value, at);
	});
}
