import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { basename, resolve } from "node:path";
import { env, getLiveSpeechLanguage, getTransferOptions, getTranslateToEnglishLanguage, requireValidMicmeConfig, writeMicmeConfigValues } from "../config.ts";
import { discoverWhisperCppModels, formatBytes, getDownloadableWhisperCppModelName, getWhisperCppModelCacheDir, getWhisperCppModelNameFromPath, isEnglishOnlyWhisperModelName, isRegularFile, isTranslationUnsupportedWhisperModelName } from "../models.ts";
import { sanitizeTerminalText } from "../terminal-text.ts";
import { type Component, decodeKittyPrintable, fuzzyFilter, Key, matchesKey, SelectList, type SelectItem, truncateToWidth, wrapTextWithAnsi } from "../terminal-ui.ts";
import type { ModelCandidate } from "../types.ts";
import { referenceClaim, referenceRows, whisperVariants } from "./catalog.ts";
import { type Choice, type Ctx, type DeviceOption, type Signal, type Variant } from "./contracts.ts";

export const LANGUAGE_LABELS: Record<string, string> = {
	auto: "Auto detect", en: "English", bs: "Bosnian", hr: "Croatian", sr: "Serbian", de: "German", es: "Spanish", fr: "French", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", tr: "Turkish",
};
export const TRANSCRIPTION_LANGUAGE_VALUES = ["en", ...Object.keys(LANGUAGE_LABELS).filter((value) => value !== "en")];
export const TRANSLATION_SOURCE_LANGUAGE_VALUES = TRANSCRIPTION_LANGUAGE_VALUES.filter((value) => value !== "auto" && value !== "en");
export const TRANSLATE_FROM_VALUE_LABELS: Record<string, string> = {
	off: "Off",
	...Object.fromEntries(TRANSLATION_SOURCE_LANGUAGE_VALUES.map((language) => [language, `${LANGUAGE_LABELS[language]} → English`])),
};

export function speechLanguageLabel(language: string) {
	return Object.hasOwn(LANGUAGE_LABELS, language) ? LANGUAGE_LABELS[language] : language;
}

export function cleanSettingText(text: string) {
	return sanitizeTerminalText(text.replace(/\p{Bidi_Control}/gu, ""));
}

export function getPrintableInput(data: string) {
	if (!data || data.includes("\x1b")) return "";
	if (matchesKey(data, Key.space)) return " ";
	if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab) || matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) return "";
	return /^[^\x00-\x1F\x7F]+$/u.test(data) ? data : "";
}

type Theme = Ctx["ui"]["theme"];
export type PickerRow = SelectItem & { details?: string[] };
export type PickerCursor = { selected?: string; query?: string };
type Picker = {
	title: string;
	rows: PickerRow[];
	heading?: string[];
	cursor?: PickerCursor;
	filter?: (query: string) => PickerRow[];
	searchHint?: string;
	maxVisible?: number;
};

// Same Pi list, keybindings and palette as the legacy model picker. Full labels
// and selected details wrap separately so clipping never hides the action or reason.
export function createSettingsPicker(options: Picker, theme: Theme, done: (value?: string) => void): Component {
	const cursor = options.cursor ?? {};
	const border = new DynamicBorder((line) => theme.fg("accent", line));
	const listTheme = {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: () => theme.fg("warning", "  No matching choices"),
	};
	let active: PickerRow | undefined;
	const updateList = () => {
		const query = cursor.query?.trim() ?? "";
		const rows = options.filter ? options.filter(query) : !query ? options.rows : fuzzyFilter(options.rows, query, (row) => `${row.label} ${row.description ?? ""}`);
		const index = Math.max(0, rows.findIndex(({ value }) => value === cursor.selected));
		active = rows[index];
		const next = new SelectList(rows.map((row) => ({ ...row, label: cleanSettingText(row.label), description: row.description && cleanSettingText(row.description) })), options.maxVisible ?? 7, listTheme);
		next.setSelectedIndex(index);
		next.onSelect = ({ value }) => { cursor.selected = value; done(value); };
		next.onSelectionChange = ({ value }) => {
			cursor.selected = value;
			active = rows.find((row) => row.value === value);
		};
		next.onCancel = () => done();
		return next;
	};
	let list = updateList();
	return {
		render(width) {
			const wrap = (text: string) => wrapTextWithAnsi(cleanSettingText(text), width).map((line) => truncateToWidth(line, width, ""));
			const lines = [theme.fg("accent", theme.bold(truncateToWidth(options.title, width)))];
			for (const heading of options.heading ?? []) lines.push(...wrap(heading));
			if (options.searchHint) lines.push(...wrap(cursor.query ? `Search: ${cursor.query}` : options.searchHint));
			lines.push(...list.render(width));
			if (active?.details?.length) for (const detail of [active.label, ...active.details]) lines.push(...wrap(detail));
			lines.push(...wrap("↑↓ move · Enter select · Esc back").map((line) => theme.fg("dim", line)));
			return [...border.render(width), ...lines, ...border.render(width)].map((line) => truncateToWidth(line, width, ""));
		},
		invalidate() { list.invalidate(); },
		handleInput(data) {
			const typed = decodeKittyPrintable(data) ?? getPrintableInput(data);
			const editing = options.searchHint && (typed || matchesKey(data, Key.backspace));
			if (!editing) return list.handleInput(data);
			cursor.query = typed ? `${cursor.query ?? ""}${typed}`.slice(0, 160) : Array.from(cursor.query ?? "").slice(0, -1).join("");
			cursor.selected = undefined;
			list = updateList();
		},
	};
}

export async function showSettingsPicker(ctx: Ctx, signal: Signal, options: Picker) {
	signal.throwIfAborted();
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		signal.throwIfAborted();
		const cancel = () => finish();
		const finish = (value?: string) => {
			signal.removeEventListener("abort", cancel);
			done(value);
		};
		signal.addEventListener("abort", cancel, { once: true });
		const component = createSettingsPicker(options, theme, finish);
		return {
			render: (width) => component.render(width),
			invalidate: () => component.invalidate(),
			handleInput(data) { component.handleInput?.(data); if (!signal.aborted) tui.requestRender(); },
		};
	});
}

/** A managed picker choice stays a name, not an explicit path exempt from integrity checks. */
export function managedWhisperName(path: string) {
	const name = getDownloadableWhisperCppModelName(path);
	return name && resolve(path) === resolve(getWhisperCppModelCacheDir(), `ggml-${name}.bin`) ? name : undefined;
}

export function whisperModelCompatibility(name: string | undefined, language = getLiveSpeechLanguage(), translate = Boolean(getTranslateToEnglishLanguage())) {
	const base = name?.replace(/-q\d+_\d+$/i, "");
	if (translate && (isEnglishOnlyWhisperModelName(base) || isTranslationUnsupportedWhisperModelName(base))) return "This model cannot translate to English. Turn translation off or choose a translation-capable model.";
	if (isEnglishOnlyWhisperModelName(base) && language !== "en" && language !== "auto") return "This model is English-only. Choose English or Auto, or choose a multilingual model.";
	return null;
}

export type CatalogModel = {
	key: string;
	label: string;
	present: boolean;
	stream: boolean;
	translate: boolean;
	languages: string[];
	group: "whisper" | "manual" | "reference";
	name?: string;
	path?: string;
	variants: Variant[];
};

export function setupCatalog(cwd: string): CatalogModel[] {
	const cache = getWhisperCppModelCacheDir();
	const standard = whisperVariants().map<CatalogModel>(({ name, row }) => ({
		key: row.id, label: `Whisper ${name}`, group: "whisper", name, variants: [row], languages: row.languages,
		present: isRegularFile(resolve(cache, row.blobs[0].path)), stream: false,
		translate: !whisperModelCompatibility(name, "en", true),
	}));
	const manual = discoverWhisperCppModels(cwd).filter(({ kind }) => kind === "path").map(manualCatalogModel);
	const reference = referenceRows().map<CatalogModel>((entry) => {
		const claim = referenceClaim(entry.id);
		return { key: entry.id, label: entry.label, group: "reference", variants: entry.variants, present: false,
			languages: [...new Set(entry.variants.flatMap((variant) => [...variant.languages, ...variant.measurements.map(({ language }) => language)]))],
			stream: Boolean(claim?.streaming), translate: Boolean(claim?.translate) };
	});
	return [...standard.sort((a, b) => Number(b.present) - Number(a.present)), ...manual, ...reference];
}

function manualCatalogModel(candidate: ModelCandidate): CatalogModel {
	const name = getWhisperCppModelNameFromPath(candidate.value);
	return { key: candidate.value, label: candidate.label, group: "manual", name, path: candidate.value,
		present: candidate.installed, stream: false, translate: false, languages: isEnglishOnlyWhisperModelName(name) ? ["en"] : [], variants: [] };
}

export function filterSetupCatalog(models: CatalogModel[], query: string) {
	const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
	return models.filter((model) => terms.every((term) => {
		if (term === "installed") return model.present;
		if (term === "stream") return model.stream;
		if (term === "translate" || term === "translation") return model.translate;
		if (term.startsWith("lang:")) {
			const search = term.slice(5);
			return !search || (search === "unknown" ? !model.languages.length : model.languages.some((language) => language.toLowerCase() === search || speechLanguageLabel(language).toLowerCase() === search));
		}
		return `${model.label} ${model.group}`.toLowerCase().includes(term);
	}));
}

export function catalogPickerRow(model: CatalogModel): PickerRow {
	const lead = model.group === "reference" ? "Reference" : model.group === "manual" ? "Manual" : "Managed";
	const status = model.group === "reference" ? "Not offered here" : model.present ? "Found · unchecked" : "Missing";
	const languages = model.languages.join(", ") || "unknown";
	const details = model.group === "reference"
		? [`${status} · ${referenceClaim(model.key)?.curated ? "curated" : "search-only in Handy"}`, `Reference claims: stream ${model.stream ? "yes" : "no"}; translate ${model.translate ? "yes" : "no"}. Measured languages: ${languages}.`]
		: [`${status} · ${lead} · measured/known languages: ${languages}.`];
	return { value: model.key, label: `${lead}: ${model.label}`, details };
}

export function describeVariant(variant: Variant) {
	const measured = variant.measurements.flatMap(({ language, task, wer, cer, xrt, rig, device }) => [
		`${language} / ${task}: WER ${wer === null ? "unknown" : `${(100 * wer).toFixed(1)}%`}; CER ${cer === null ? "unknown" : `${(100 * cer).toFixed(1)}%`}; speed ${xrt === null ? "unknown" : `${xrt}× realtime`}.`,
		`Observed rig: ${rig}; device ${device ? [device.label, device.id].filter(Boolean).join(" / ") : "unknown"}.`,
	]);
	return [
		`Rights: ${variant.rights}. Runtime evidence: ${variant.runtime}.`,
		...(variant.reason ? [variant.reason] : []),
		...variant.blobs.map((blob) => `Artifact: ${blob.path} (${formatBytes(blob.bytes)}); revision ${blob.revision}.`),
		...(variant.terms ? [`Terms: ${variant.terms}`] : []),
		...(!measured.length ? ["Measured rig, accuracy and speed: unknown."] : measured),
	];
}

export class SetupMessage extends Error {}

export function checkSetupModelSelection(group: CatalogModel["group"]) {
	requireValidMicmeConfig();
	if (getTransferOptions().MICME_ARTIFACT) throw new SetupMessage("An optional artifact is selected. Clear it in Advanced settings before changing the legacy Whisper model.");
	if (process.env.MICME_WHISPER_CPP_MODEL !== undefined || (group === "whisper" && process.env.MICME_DEFAULT_WHISPER_CPP_MODEL !== undefined)) {
		throw new SetupMessage("The shell overrides the Whisper model. Change the model in the shell and restart Pi.");
	}
}

export async function selectSetupModel(model: CatalogModel, signal: Signal) {
	checkSetupModelSelection(model.group);
	await writeMicmeConfigValues(model.group === "whisper"
		? { MICME_DEFAULT_WHISPER_CPP_MODEL: model.name, MICME_WHISPER_CPP_MODEL: undefined }
		: { MICME_WHISPER_CPP_MODEL: model.path }, { signal });
}

export type AdvancedRuntime = { installed: Choice[]; compute: DeviceOption[] };
export async function discoverAdvancedRuntime(signal: Signal): Promise<AdvancedRuntime> {
	const { listInstalled, listCompute } = await import("./recognition.ts");
	signal.throwIfAborted();
	const installed = await listInstalled();
	signal.throwIfAborted();
	return { installed, compute: installed.length ? await listCompute() : [] };
}

export function configuredModelLabel(path: string) {
	return cleanSettingText(basename(path)) || "model";
}

export function sensitiveOptionsSummary() {
	const options = getTransferOptions();
	return [
		`Polish provider: ${options.MICME_POLISH_PROVIDER ?? "off"}. Use /micme polish or /micme preview to confirm it for one take.`,
		`Output hook: ${env("MICME_OUTPUT_HOOK")?.trim() ? "configured (hidden)" : "off"}. Ordinary takes and Try It never invoke it.`,
		"Endpoint, prompt, model name, credential source, hook path and text lists are hidden from diagnostics.",
	];
}
