import { getTransferOptions, getTranslateToEnglishLanguage } from "../config.ts";
import type {
	Choice, DetectBatchLanguage, Final, FinishLocal, Lang, RecognitionTask, ResolveLanguage, Rule, RuleOutcome,
	Signal, SpeechLanguage, Traits, TransferOptions, VerifiedAudio,
} from "./contracts.ts";
import { BUILTIN_FILLERS, CHINESE_FORMS } from "./language-data.ts";

const MIN_LID_SPEECH_MS = 5_000;

type LanguagePolicy = { fixed: Lang | null; allowed: Lang[]; nativeAuto: boolean; batchLid: boolean };

function locale(tag: Lang | null) {
	if (!tag || tag === "auto") return null;
	try { return new Intl.Locale(tag); } catch { return null; }
}

function compatibleLanguage(requested: Lang, available: readonly Lang[]) {
	if (available.includes(requested)) return requested;
	const canonical = locale(requested);
	if (!canonical) return null;
	// A regional hint can use a model's base language. Do not silently switch
	// to another advertised region/script (for example pt-PT to pt-BR).
	if (available.includes(canonical.baseName)) return canonical.baseName;
	return available.includes(canonical.language) ? canonical.language : null;
}

function languagePolicy(choice: Choice, traits: Traits, preferences: readonly Lang[]): LanguagePolicy {
	if (choice.task === "translate-en" && !traits.translateEn) throw new Error("The loaded recognition model cannot translate to English.");
	if (choice.language !== "auto") {
		const fixed = compatibleLanguage(choice.language, traits.languages);
		if (!fixed) throw new Error("The loaded recognition model does not support the selected language.");
		return { fixed, allowed: [fixed], nativeAuto: false, batchLid: false };
	}
	const wanted = new Set<Lang>();
	for (const preference of preferences) {
		const supported = compatibleLanguage(preference, traits.languages);
		if (supported) wanted.add(supported);
	}
	const available = [...new Set(traits.languages)];
	const allowed = preferences.length ? [...wanted] : available;
	return {
		fixed: allowed.length === 1 ? allowed[0]! : available.length === 1 ? available[0]! : null,
		allowed,
		nativeAuto: traits.nativeLid && available.length > 0,
		batchLid: traits.batch && !traits.stream && allowed.length > 1,
	};
}

function nativeFallback(policy: LanguagePolicy): SpeechLanguage {
	if (policy.fixed) return policy.fixed;
	if (policy.nativeAuto) return "auto";
	throw new Error("This model cannot choose a language automatically. Select a supported language.");
}

function batchDetection(policy: LanguagePolicy, detected: Lang | null) {
	if (!policy.batchLid || !detected) return null;
	return compatibleLanguage(detected, policy.allowed);
}

export const resolveLanguage: ResolveLanguage = (choice, traits, preferences, detected) => {
	const policy = languagePolicy(choice, traits, preferences);
	return batchDetection(policy, detected) ?? nativeFallback(policy);
};

type BatchLanguageInput = {
	enabled: boolean;
	audio: VerifiedAudio;
	/** Duration classified as speech by the caller, not elapsed or nonzero PCM. */
	speechMs: number | null;
	detect?: DetectBatchLanguage;
};
type LidResult = "off" | "incompatible" | "not-needed" | "unavailable" | "insufficient-speech" | "no-decision" | "detected";

function batchFallback(policy: LanguagePolicy, localLid: Exclude<LidResult, "detected">) {
	if (!policy.fixed && !policy.nativeAuto) {
		throw new Error(`This model cannot choose a language automatically (local LID: ${localLid}). Select a supported language.`);
	}
	return { language: nativeFallback(policy), localLid };
}

/** Optional E adapter boundary: only the owner of verified, speech-scored batch audio calls this. */
export async function resolveBatchLanguage(choice: Choice, traits: Traits, preferences: readonly Lang[], input: BatchLanguageInput, signal: Signal):
	Promise<{ language: SpeechLanguage; localLid: LidResult }> {
	signal.throwIfAborted();
	const policy = languagePolicy(choice, traits, preferences);
	if (!input.enabled) return batchFallback(policy, "off");
	if (policy.fixed) return batchFallback(policy, "not-needed");
	if (!policy.batchLid) return batchFallback(policy, "incompatible");
	if (!input.detect) return batchFallback(policy, "unavailable");
	if (input.speechMs === null || !Number.isFinite(input.speechMs) || input.speechMs < MIN_LID_SPEECH_MS) {
		return batchFallback(policy, "insufficient-speech");
	}
	let detected: Lang | null;
	try { detected = await input.detect(input.audio, [...policy.allowed], signal); }
	catch {
		signal.throwIfAborted();
		return batchFallback(policy, "unavailable");
	}
	signal.throwIfAborted();
	const language = batchDetection(policy, detected);
	return language ? { language, localLid: "detected" } : batchFallback(policy, "no-decision");
}

type LocalSettings = Pick<TransferOptions, "MICME_WORDS" | "MICME_FILLERS" | "MICME_REMOVE_FILLERS" | "MICME_SCRIPT">;
type FinishContext = {
	settings?: LocalSettings;
	task?: RecognitionTask;
	/** True only after the engine accepted the take's native hints. */
	nativeBias?: boolean;
	/** Supply only independent, conclusive speech evidence. Text is not a VAD. */
	speech?: "speech" | "none";
};

type Span = { start: number; end: number; text: string };
type Transform = { text: string; matched: boolean };
type Phrase = string[];

// Quotes, backticks and grouped expressions are opaque. Whitespace and
// prose separators expose candidates, but symbols inside a chunk (request.id,
// e-mail, AB-204, #tag) make the entire chunk ineligible.
const CHUNKS = /(`+)[\s\S]*?(?:\1(?!`)|$)|"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|(?<![\p{L}\p{M}\p{N}])'(?:\\(?:[\s\S]|$)|[^'\\])*(?:'|$)|[()[\]{}]|(?:[^\s,;!?。！？、；，："“”‘’'`()[\]{}]|(?<=[\p{L}\p{M}\p{N}])['’](?=[\p{L}\p{M}\p{N}]))+/gu;
const GROUP_END = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
const PROSE_BOUNDARY = /^[\s,;!?。！？、；，：]$/u;
const LETTER_WORD = /^\p{L}[\p{L}\p{M}]*$/u;
const LATIN_WORD = /^\p{Script=Latin}[\p{Script=Latin}\p{M}]*$/u;
const HAN_WORD = /^\p{Script=Han}+$/u;
const SPACE = /^[\t ]+$/u;
const COMMA_SPACE = /^,[\t ]+$/u;

function spans(text: string): Span[] {
	const result: Span[] = [];
	const groups: string[] = [];
	for (const match of text.matchAll(CHUNKS)) {
		const chunk = match[0];
		const closer = GROUP_END.get(chunk);
		if (closer) groups.push(closer);
		const protectedGroup = groups.length > 0;
		if (groups.at(-1) === chunk) groups.pop();
		const start = match.index;
		const end = start + chunk.length;
		const token = chunk.endsWith(".") ? chunk.slice(0, -1) : chunk;
		const prose = !protectedGroup && (start === 0 || PROSE_BOUNDARY.test(text[start - 1]!)) &&
			(end === text.length || PROSE_BOUNDARY.test(text[end]!));
		result.push({ start, end: start + token.length, text: prose ? token : "" });
	}
	return result;
}

function lower(text: string) { return text.normalize("NFC").toLowerCase(); }
function fold(text: string) { return lower(text).normalize("NFD").replace(/\p{M}/gu, ""); }

function proseCase(text: string) {
	return text === text.toLowerCase() || text.slice(1) === text.slice(1).toLowerCase();
}

function phraseIndex(entries: readonly string[], key: (text: string) => string) {
	const unique = new Map<string, Phrase | null>();
	for (const entry of entries) {
		const words = entry.trim().normalize("NFC").split(/[\t ]+/u);
		if (!words.every((word) => LATIN_WORD.test(word))) continue;
		const folded = words.map(key).join(" ");
		const known = unique.get(folded);
		if (known === undefined) unique.set(folded, words);
		else if (known?.join(" ") !== words.join(" ")) unique.set(folded, null);
	}
	const byFirst = new Map<string, Phrase[]>();
	for (const words of unique.values()) {
		if (!words) continue;
		const first = key(words[0]!);
		const prior = byFirst.get(first);
		if (prior) prior.push(words);
		else byFirst.set(first, [words]);
	}
	for (const words of byFirst.values()) words.sort((a, b) => b.length - a.length);
	return byFirst;
}

function wordMatches(actual: string, expected: string, key: (text: string) => string) {
	return LATIN_WORD.test(actual) && (actual === expected || (proseCase(actual) && key(actual) === key(expected)));
}

function phraseMatches(text: string, words: readonly Span[], from: number, phrase: readonly string[], key: (text: string) => string) {
	for (let i = 0; i < phrase.length; i++) {
		const word = words[from + i];
		if (!word || !wordMatches(word.text, phrase[i]!, key)) return false;
		if (i && !SPACE.test(text.slice(words[from + i - 1]!.end, word.start))) return false;
	}
	return true;
}

function applySpans(text: string, replacements: readonly Span[]): Transform {
	let cursor = 0;
	const output = [];
	for (const replacement of replacements) {
		output.push(text.slice(cursor, replacement.start), replacement.text);
		cursor = replacement.end;
	}
	return { text: replacements.length ? output.join("") + text.slice(cursor) : text, matched: replacements.length > 0 };
}

function vocabulary(text: string, entries: readonly string[]): Transform {
	const index = phraseIndex(entries, fold);
	const words = spans(text);
	const replacements: Span[] = [];
	for (let i = 0; i < words.length; i++) {
		const candidates = index.get(fold(words[i]!.text));
		const match = candidates?.find((phrase) => phraseMatches(text, words, i, phrase, fold));
		if (!match) continue;
		for (const preferred of match) replacements.push({ ...words[i++]!, text: preferred });
		i--;
	}
	return applySpans(text, replacements);
}

function fillers(text: string, entries: readonly string[]): Transform {
	const index = phraseIndex(entries.map(lower), lower);
	const words = spans(text);
	const replacements: Span[] = [];
	for (let i = 0; i < words.length; i++) {
		const first = words[i]!;
		const before = words[i - 1];
		if (before ? !COMMA_SPACE.test(text.slice(before.end, first.start)) : text.slice(0, first.start).trim()) continue;
		const match = index.get(lower(first.text))?.find((phrase) => phraseMatches(text, words, i, phrase, lower));
		if (!match) continue;
		const end = i + match.length;
		const after = words[end];
		if (!after || !LATIN_WORD.test(after.text) || !COMMA_SPACE.test(text.slice(words[end - 1]!.end, after.start))) continue;
		// Repetition (including a repeated multiword custom phrase) is ambiguous.
		if (phraseMatches(text, words, i - match.length, match, lower) || phraseMatches(text, words, end, match, lower)) continue;
		replacements.push({ start: first.start, end: after.start, text: "" });
		i = end - 1;
	}
	return applySpans(text, replacements);
}

const scriptPhrases = [...new Set(CHINESE_FORMS.flat())].sort((a, b) => b.length - a.length).join("|");
const SCRIPT_PHRASE = new RegExp(scriptPhrases, "gu");

function script(text: string, target: Exclude<TransferOptions["MICME_SCRIPT"], "as-spoken">): Transform {
	const form = target === "simplified" ? 0 : target === "taiwan" ? 1 : 2;
	const replacements: Span[] = [];
	for (const span of spans(text)) {
		if (!HAN_WORD.test(span.text)) continue;
		for (const match of span.text.matchAll(SCRIPT_PHRASE)) {
			const forms = CHINESE_FORMS.find((row) => row.some((word) => word === match[0]));
			if (!forms) continue;
			const start = span.start + match.index;
			replacements.push({ start, end: start + match[0].length, text: forms[form] });
		}
	}
	return applySpans(text, replacements);
}

function echoReason(text: string, words: readonly string[], speech: FinishContext["speech"], source: Final["source"]): RuleOutcome["reason"] {
	if (!words.length) return "off";
	const trimmed = text.trim();
	if (!trimmed) return "insufficient-speech";
	if (speech === "speech") return "no-match";
	if (trimmed === ".") return source !== "live" || speech === "none" ? "applied" : "insufficient-speech";
	// An exact configured match is not enough to drop a literal or a repeat.
	const textWithoutPeriod = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
	const tokens = textWithoutPeriod.split(/[\t ]+/u);
	if (!tokens.every((token) => LETTER_WORD.test(token) && proseCase(token))) return "no-match";
	if (new Set(tokens.map(lower)).size !== tokens.length) return "no-match";
	const phrase = lower(textWithoutPeriod);
	if (!words.some((word) => lower(word.trim()) === phrase)) return "no-match";
	return speech === "none" ? "applied" : "insufficient-speech";
}

function decision(rule: Rule, reason: RuleOutcome["reason"]): RuleOutcome {
	return { rule, result: reason === "applied" ? "applied" : "skipped", reason };
}

function applyRule(rule: Rule, text: string, enabled: boolean, eligible: boolean, run: () => Transform) {
	if (!enabled) return { text, outcome: decision(rule, "off") };
	if (!eligible) return { text, outcome: decision(rule, "incompatible") };
	if (!text.trim()) return { text, outcome: decision(rule, "insufficient-speech") };
	const result = run();
	return { text: result.text, outcome: decision(rule, result.matched ? "applied" : "no-match") };
}

export const finishLocal = ((raw, language, source, context: FinishContext = {}) => {
	const preferences = context.settings ?? getTransferOptions();
	const task = context.task ?? (!context.settings && source === "clip" && getTranslateToEnglishLanguage() ? "translate-en" : "transcribe");
	const tag = locale(task === "translate-en" ? "en" : language);
	const primary = tag?.language;
	const latin = tag?.maximize().script === "Latn";
	const chinese = primary === "zh" || primary === "yue";
	const words = preferences.MICME_WORDS;
	const hasWords = words.length > 0;
	const bias = decision("bias", context.nativeBias ? "applied" : hasWords ? "incompatible" : "off");
	const echoRule = decision("echo", echoReason(raw, words, context.speech, source));
	const initial = echoRule.result === "applied" ? "" : raw;
	const corrected = applyRule("vocabulary", initial, hasWords && !context.nativeBias, latin, () => vocabulary(initial, words));
	const fillerWords = primary ? BUILTIN_FILLERS[primary] ?? [] : [];
	const unfilled = applyRule("fillers", corrected.text, preferences.MICME_REMOVE_FILLERS, latin,
		() => fillers(corrected.text, [...fillerWords, ...preferences.MICME_FILLERS]));
	const target = preferences.MICME_SCRIPT;
	const converted = target === "as-spoken" ? { text: unfilled.text, outcome: decision("script", "off") } :
		applyRule("script", unfilled.text, true, chinese, () => script(unfilled.text, target));
	return { raw, local: converted.text, language, source, rules: [bias, corrected.outcome, unfilled.outcome, echoRule, converted.outcome] } satisfies Final;
}) satisfies FinishLocal;
