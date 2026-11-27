import { AUXILIARY_ROWS, REVIEWED_EXPORTS, STANDARD_VAD, STANDARD_WHISPER, TAGGED_ROWS } from "./catalog-data.ts";
import type { Cell, DeviceIdentity, Entry, GetEngineEvidence, Lang, RecognitionTask, Traits, Variant } from "./contracts.ts";
import { getEngineEvidence } from "./engine-evidence.ts";

export type AuxiliaryReference = { id: string; role: "asr" | "langid" | "vad" | "diarize"; repository: string; revision: string };
export type ReferenceClaim = {
	id: string;
	curated: boolean;
	streaming: boolean;
	translate: boolean;
	defaultQuant: string;
	repository: string;
	revision: string;
	license: string;
	variants: { id: string; quant: string; path: string }[];
	rights: Variant["rights"];
	reason: string;
};
export type StandardWhisper = { name: string; row: Variant };
// `rig` is the exact evidence key (engine build, OS/arch and hardware/driver cohort).
export type CatalogRig = { rig: Cell["rig"]; actualCompute: Traits["actualCompute"]; device: DeviceIdentity | null };

function sameDevice(a: DeviceIdentity | null, b: DeviceIdentity | null): boolean {
	if (a === null || b === null) return a === b;
	return a.id === b.id && a.label === b.label;
}

function verifiedCell(cell: Cell): boolean {
	return Boolean(cell.rig && cell.evidence) && (cell.disposition === "existing-verified" || cell.disposition === "adapted-verified");
}

function measuredTrait(traits: Traits, cell: Cell): boolean {
	return traits.languages.includes(cell.language) && (cell.task === "transcribe" ? traits.stream || traits.batch : traits.translateEn);
}

// The lookup key is generated from the exact blob identity, not from a model name.
// One loaded Traits snapshot can qualify only one rig/device; otherwise keep the cells
// as observations, without treating any as proof of binding the selected runtime.
export function applyCatalogEvidence(variant: Variant, lookup: GetEngineEvidence, scope?: CatalogRig): Variant {
	if (variant.rights !== "cleared" || !variant.blobs.length) return variant;
	// An incoming row may already have observations or qualification from another scope.
	const baseline: Variant = scope ? {
		...variant,
		runtime: variant.runtime === "passed" ? "untested" : variant.runtime,
		traits: null,
		languages: [],
		measurements: [],
		reason: variant.reason ?? "No qualified native evidence for this rig and device.",
	} : variant;
	const observation = lookup(variant.id);
	if (!observation) return baseline;
	const { traits, runtime, measurements } = observation;
	if (!scope) return { ...variant, measurements: structuredClone(measurements) };
	if (!traits || traits.actualCompute === "unknown" || traits.actualCompute !== scope.actualCompute || !sameDevice(traits.boundDevice, scope.device)) return baseline;
	const cells = measurements.filter((cell) => cell.rig === scope.rig && sameDevice(cell.device, scope.device));
	const result = { ...baseline, measurements: structuredClone(cells) };
	if (runtime !== "passed") return result;
	const verified = measurements.filter(verifiedCell);
	if (!verified.length || verified.some((cell) => cell.rig !== scope.rig || !sameDevice(cell.device, scope.device) || !measuredTrait(traits, cell))) return result;
	return { ...result, runtime, traits: structuredClone(traits), languages: [...new Set(verified.map((cell) => cell.language))], reason: null };
}

function referenceVariant(claim: ReferenceClaim, variant: ReferenceClaim["variants"][number], scope?: CatalogRig): Variant {
	const pinned = REVIEWED_EXPORTS.find(({ id }) => id === variant.id);
	if (pinned) return applyCatalogEvidence(structuredClone(pinned), getEngineEvidence, scope);
	return {
		id: variant.id,
		quant: variant.quant,
		blobs: [], // Tagged pin alone is not a Micme download source.
		baseRevision: null,
		conversion: null,
		terms: null,
		attribution: null,
		rights: claim.rights,
		runtime: "needs-adapter",
		languages: [],
		traits: null,
		measurements: [],
		reason: claim.reason,
	};
}

/** Handy's closed ASR inventory, not a union of installed/custom model names. */
export function referenceRows(scope?: CatalogRig): readonly Entry[] {
	return TAGGED_ROWS.map((claim) => ({
		id: claim.id,
		label: claim.id,
		curated: claim.curated,
		variants: claim.variants.map((variant) => referenceVariant(claim, variant, scope)),
	}));
}

/** Claims are reported separately from loaded traits or verified languages. */
export function referenceClaim(id: string): ReferenceClaim | null {
	return structuredClone(TAGGED_ROWS.find((row) => row.id === id) ?? null);
}

export function auxiliaryReferences(): readonly AuxiliaryReference[] {
	return structuredClone(AUXILIARY_ROWS);
}

export function whisperVariants(): readonly StandardWhisper[] {
	return structuredClone(STANDARD_WHISPER);
}

export function getWhisperVariant(name: string): Variant | null {
	return structuredClone(STANDARD_WHISPER.find((item) => item.name === name)?.row ?? null);
}

/** The separate, already supported Silero pin. Not an ASR variant. */
export function whisperVadVariant(): Variant {
	return structuredClone(STANDARD_VAD);
}

/** Inventory lookup only. An exact match does not authorize a download. */
export function getCatalogVariant(id: string, scope?: CatalogRig): Variant | null {
	const standard = STANDARD_WHISPER.find(({ row }) => row.id === id);
	if (standard) {
		const row = structuredClone(standard.row);
		if (!scope || (scope.actualCompute === "cpu" && scope.device === null && row.measurements.some((cell) => cell.rig === scope.rig))) return row;
		return { ...row, runtime: "untested", languages: [], measurements: [], reason: "No qualified Whisper clip evidence for this rig and device." };
	}
	for (const claim of TAGGED_ROWS) {
		const variant = claim.variants.find((item) => item.id === id);
		if (variant) return referenceVariant(claim, variant, scope);
	}
	return null;
}

function offersTask(variant: Variant | null, task: RecognitionTask, language: Lang): variant is Variant {
	return variant !== null && variant.rights === "cleared" && variant.runtime === "passed" && variant.blobs.length > 0
		&& variant.measurements.some((cell) => verifiedCell(cell) && cell.task === task && cell.language === language);
}

/** Standard whisper.cpp downloads are backed by exact-weight CPU clip smoke evidence. */
export function getManagedWhisperVariant(name: string): Variant | null {
	const variant = getWhisperVariant(name);
	return offersTask(variant, "transcribe", "en") ? variant : null;
}

/** New native variants cannot be offered without a compatible, observed task and rig. */
export function getManagedCatalogVariant(id: string, scope: CatalogRig, task: RecognitionTask, language: Lang): Variant | null {
	const variant = getCatalogVariant(id, scope);
	return variant?.traits && offersTask(variant, task, language) ? variant : null;
}
