import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { showRuleOutcomes } from "../src/transfer/host.ts";
import { finishLocal, resolveBatchLanguage, resolveLanguage } from "../src/transfer/language.ts";
import { decodeTransferOptions } from "../src/transfer/options.ts";
import { createRecognitionService } from "../src/transfer/recognition.ts";
import { wavHeader } from "./live-native/corpus.mjs";

const batchTraits = { stream: false, batch: true, longForm: false, nativeLid: true, bias: false, translateEn: true,
	languages: ["fr", "pt", "ja", "en"], vad: "off", actualCompute: "cpu", boundDevice: null };
const choice = { variantId: "unit-exact-model", compute: "auto", requestedDeviceId: null, language: "auto", task: "transcribe", detector: "off", chunking: false };
const signal = new AbortController().signal;
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

function settings(overrides = {}) {
	return decodeTransferOptions((key) => overrides[key]);
}

function outcome(final, rule) {
	return final.rules.find((decision) => decision.rule === rule);
}

function verifiedAudio(pcm) {
	const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
	return { bytes: wav.length, sha256: sha(wav), copyTo: async (dir) => {
		const path = join(dir.filesPath, "verified.wav");
		const fd = dir.createPrivateFile(path);
		try { writeFileSync(fd, wav); } finally { closeSync(fd); }
		return path;
	} };
}

class StubRecognizerEngine {
	maxInputSamples = 16_000;
	binarySha256 = "0".repeat(64);
	threads = 1;
	pcm = Buffer.alloc(0);
	begun = null;

	constructor(traits, raw) { this.traits = traits; this.raw = raw; }
	async begin(language, words) { this.begun = { language, words }; }
	async feed(from, pcm, last) {
		this.pcm = Buffer.concat([this.pcm, pcm]);
		return last ? [{ kind: "commit", from: 0, to: from, text: this.raw }] : [];
	}
	async batch(pcm) { this.pcm = pcm; return this.raw; }
	async close() { /* No worker owned by this fixture. */ }
	evidence() { return { inputSamples: this.pcm.length / 2, inputPcmSha256: sha(this.pcm) }; }
}

function isolateConfig(t, textOptions) {
	const dir = mkdtempSync(join(tmpdir(), "micme-language-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	t.mock.property(process, "env", { PI_CODING_AGENT_DIR: dir, ...textOptions });
	return () => settings(textOptions);
}

test("explicit language beats wrong detection, then a single compatible preference beats Auto", () => {
	assert.equal(resolveLanguage({ ...choice, language: "fr" }, batchTraits, ["pt"], "en"), "fr");
	assert.equal(resolveLanguage(choice, batchTraits, ["pt-BR", "pt", "de"], "fr"), "pt");
	assert.equal(resolveLanguage(choice, batchTraits, ["de"], null), "auto");
	assert.equal(resolveLanguage(choice, { ...batchTraits, nativeLid: false, languages: ["fr"] }, [], null), "fr");
	assert.throws(() => resolveLanguage({ ...choice, language: "de" }, batchTraits, ["pt"], "en"), /does not support the selected language/);
	assert.throws(() => resolveLanguage(choice, { ...batchTraits, nativeLid: false }, [], null), /select a supported language/i);
});

test("translation is explicit and requires a translate-to-English trait", () => {
	const incapable = { ...batchTraits, translateEn: false };
	const french = { ...choice, language: "fr" };
	assert.equal(resolveLanguage(french, incapable, [], null), "fr");
	assert.throws(() => resolveLanguage({ ...french, task: "translate-en" }, incapable, [], null), /cannot translate to English/);
	assert.equal(resolveLanguage({ ...french, task: "translate-en" }, batchTraits, [], null), "fr");
});

test("legacy clip translation finishes English output without relabeling the source language", (t) => {
	isolateConfig(t, { MICME_TRANSLATE_TO_ENGLISH: "zh", MICME_WORDS: '["José"]', MICME_SCRIPT: "taiwan" });
	const final = finishLocal("Ask jose about 軟件.", "zh", "clip");
	assert.equal(final.raw, "Ask jose about 軟件.");
	assert.equal(final.local, "Ask José about 軟件.");
	assert.equal(final.language, "zh");
	assert.equal(outcome(final, "script").reason, "incompatible");
});

test("batch LID sees only compatible choices after five seconds of measured speech", async () => {
	const audio = verifiedAudio(Buffer.alloc(6 * 32_000));
	const preferences = ["fr-CA", "ja", "de"];
	const common = { enabled: true, audio };
	const unavailable = await resolveBatchLanguage(choice, batchTraits, preferences, { ...common, speechMs: 5_000 }, signal);
	assert.deepEqual(unavailable, { language: "auto", localLid: "unavailable" });
	const short = await resolveBatchLanguage(choice, batchTraits, preferences, { ...common, speechMs: 4_999,
		detect: () => assert.fail("must not detect on insufficient speech") }, signal);
	assert.deepEqual(short, { language: "auto", localLid: "insufficient-speech" });
	const detected = await resolveBatchLanguage(choice, batchTraits, preferences, { ...common, speechMs: 5_000,
		detect: async (input, allowed, active) => {
			assert.equal(input, audio);
			assert.equal(active, signal);
			assert.deepEqual(allowed, ["fr", "ja"]);
			return "fr";
		} }, signal);
	assert.deepEqual(detected, { language: "fr", localLid: "detected" });
	const wrong = await resolveBatchLanguage(choice, batchTraits, preferences, { ...common, speechMs: 5_000, detect: async () => "en" }, signal);
	assert.deepEqual(wrong, { language: "auto", localLid: "no-decision" });
	const excluded = await resolveBatchLanguage(choice, batchTraits, ["de"], { ...common, speechMs: 5_000,
		detect: () => assert.fail("must not widen an empty intersection") }, signal);
	assert.deepEqual(excluded, { language: "auto", localLid: "incompatible" });
});

test("cancelled local language detection cannot publish a late language or fall back", async () => {
	const controller = new AbortController();
	await assert.rejects(resolveBatchLanguage(choice, batchTraits, ["fr", "ja"], { enabled: true, speechMs: 5_000,
		audio: verifiedAudio(Buffer.alloc(6 * 32_000)), detect: async () => {
			controller.abort(new Error("take canceled"));
			return "fr";
		} }, controller.signal), /take canceled/);
});

test("a long-context stream begins with native Auto before seeing any speech, not with a batch detection", async (t) => {
	const configured = isolateConfig(t, { MICME_LOCAL_LID: "1", MICME_PREFERRED_LANGUAGES: '["fr","ja"]', MICME_WORDS: '["Tokyo"]' });
	const engine = new StubRecognizerEngine({ ...batchTraits, bias: true, stream: true, longForm: true }, "Tokyo");
	assert.equal(resolveLanguage(choice, engine.traits, ["fr", "ja"], "fr"), "auto");
	const api = createRecognitionService({ settings: configured, load: async () => engine });
	const updates = [];
	const rec = await api.openRecognizer(choice, (update) => updates.push(update), signal);
	assert.deepEqual(engine.begun, { language: "auto", words: ["Tokyo"] });
	assert.equal(engine.pcm.length, 0);
	const pcm = Buffer.from([11, 0, 12, 0]);
	await rec.push(0, pcm, signal);
	const final = await rec.finish(verifiedAudio(pcm), signal);
	assert.deepEqual(outcome(final, "bias"), { rule: "bias", result: "applied", reason: "applied" });
	assert.equal(final.raw, final.local);
	assert.deepEqual(updates, [{ kind: "commit", from: 0, to: 2, text: final.raw }]);
});

test("vocabulary restores only unambiguous whole prose phrases and preserves identifiers and numbers", () => {
	const raw = 'Ask jose about new york and José. Keep requestId, jose_api, JOSÉ_ID, jose.rs, @jose, #jose, jose-204, 09:15, `jose` and call("keep jose alone"). Say jose jose.';
	const enabled = settings({ MICME_WORDS: '["José","New York","Requestid","204"]' });
	const final = finishLocal(raw, "en", "clip", { settings: enabled });
	assert.equal(final.raw, raw);
	assert.equal(final.local, raw.replace("Ask jose about new york", "Ask José about New York").replace("Say jose jose", "Say José José"));
	assert.deepEqual(outcome(final, "vocabulary"), { rule: "vocabulary", result: "applied", reason: "applied" });
	assert.equal(outcome(final, "bias").reason, "incompatible");
	assert.equal(finishLocal(raw, "en", "clip", { settings: settings() }).local, raw);
	const ambiguous = finishLocal("I asked jose and joes.", "en", "clip", { settings: settings({ MICME_WORDS: '["José","Jose"]' }) });
	assert.equal(ambiguous.local, ambiguous.raw);
	assert.equal(outcome(ambiguous, "vocabulary").reason, "no-match");
});

test("accepted native bias is not followed by a second vocabulary rewrite", () => {
	const final = finishLocal("Ask jose.", "en", "live", { settings: settings({ MICME_WORDS: '["José"]' }), nativeBias: true });
	assert.equal(final.local, final.raw);
	assert.equal(outcome(final, "bias").result, "applied");
	assert.equal(outcome(final, "vocabulary").reason, "off");
});

test("fillers remove opt-in hesitation asides, not ambiguous words, deliberate repeats or identifiers", () => {
	const english = "Um, Please, um, check um_count and, hesitation mark, keep like, well, so and uh, uh, repeat repeat 204.";
	const enabled = settings({ MICME_REMOVE_FILLERS: "1", MICME_FILLERS: '["hesitation mark"]' });
	const clean = finishLocal(english, "en", "clip", { settings: enabled });
	assert.equal(clean.raw, english);
	assert.equal(clean.local, "Please, check um_count and, keep like, well, so and uh, uh, repeat repeat 204.");
	assert.equal(outcome(clean, "fillers").result, "applied");
	assert.equal(finishLocal("Euh, Bonjour.", "fr", "clip", { settings: enabled }).local, "Bonjour.");
	assert.equal(outcome(finishLocal("Um, 東京。", "ja", "clip", { settings: enabled }), "fillers").reason, "incompatible");
});

test("a period or a vocabulary-only negative can be suppressed without mistaking a spoken name for an echo", () => {
	const enabled = settings({ MICME_WORDS: '["Tokyo","New York"]' });
	const dot = finishLocal(".", "en", "clip", { settings: enabled });
	assert.equal(dot.raw, ".");
	assert.equal(dot.local, "");
	assert.equal(outcome(dot, "echo").result, "applied");
	const negative = finishLocal("New York.", "en", "clip", { settings: enabled, speech: "none" });
	assert.equal(negative.local, "");
	assert.equal(finishLocal("Tokyo.", "en", "clip", { settings: enabled }).local, "Tokyo.");
	assert.equal(finishLocal("Tokyo Tokyo.", "en", "clip", { settings: enabled, speech: "none" }).local, "Tokyo Tokyo.");
	assert.equal(outcome(finishLocal("", "en", "clip", { settings: enabled }), "echo").reason, "insufficient-speech");
	assert.equal(finishLocal(".", "en", "clip", { settings: settings() }).local, ".");
});

test("script uses region-specific Chinese phrase forms and leaves protected Han names and other languages alone", () => {
	const raw = "這個軟件支援打印機，也支援 `軟件 API` 和 軟件2。";
	const outputs = { simplified: "这个软件支持打印机，也支援 `軟件 API` 和 軟件2。", taiwan: "這個軟體支援印表機，也支援 `軟件 API` 和 軟件2。", "hong-kong": raw };
	for (const [variant, expected] of Object.entries(outputs)) {
		const result = finishLocal(raw, "zh-Hant-HK", "import", { settings: settings({ MICME_SCRIPT: variant }) });
		assert.equal(result.raw, raw);
		assert.equal(result.local, expected);
		assert.equal(outcome(result, "script").result, "applied");
	}
	const japan = finishLocal("東京駅です。", "ja", "clip", { settings: settings({ MICME_SCRIPT: "simplified" }) });
	assert.equal(japan.local, japan.raw);
	assert.equal(outcome(japan, "script").reason, "incompatible");
});

test("unchanged public file results carry distinct visible applied and incompatible labels", async (t) => {
	const configured = isolateConfig(t, { MICME_SCRIPT: "taiwan", MICME_WORDS: '["José"]' });
	const raw = "這個軟體支援印表機。";
	const traits = { ...batchTraits, languages: ["zh"], bias: false };
	const api = createRecognitionService({ settings: configured, load: async () => new StubRecognizerEngine(traits, raw) });
	const final = await api.recognizeFile(verifiedAudio(Buffer.from([11, 0, 12, 0])), { ...choice, language: "zh" }, "import", () => {}, signal);
	assert.equal(final.raw, raw);
	assert.equal(final.local, raw);
	assert.deepEqual(outcome(final, "script"), { rule: "script", result: "applied", reason: "applied" });
	assert.deepEqual(outcome(final, "vocabulary"), { rule: "vocabulary", result: "skipped", reason: "incompatible" });
	const notices = [];
	showRuleOutcomes({ ui: { notify: (message) => notices.push(message) } }, final);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /vocabulary: skipped \(incompatible\).*script: applied/);
});

test("local review may improve while a confirmed editor commit keeps the exact raw text", async (t) => {
	const configured = isolateConfig(t, { MICME_WORDS: '["José"]' });
	const engine = new StubRecognizerEngine({ ...batchTraits, stream: true }, "Ask jose.");
	const api = createRecognitionService({ settings: configured, load: async () => engine });
	const updates = [];
	const rec = await api.openRecognizer({ ...choice, language: "en" }, (update) => updates.push(update), signal);
	const pcm = Buffer.from([11, 0, 12, 0]);
	await rec.push(0, pcm, signal);
	const final = await rec.finish(verifiedAudio(pcm), signal);
	assert.equal(final.local, "Ask José.");
	assert.equal(final.raw, "Ask jose.");
	assert.deepEqual(updates, [{ kind: "commit", from: 0, to: 2, text: "Ask jose." }]);
});
