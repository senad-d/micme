import { posix } from "node:path";
import {
	DETECTORS,
	MODEL_IDLE_MODES,
	POLISH_PROVIDERS,
	RETENTION_DAYS,
	SCRIPTS,
	TRANSFER_FLAGS,
	TRANSFER_OPTION_DEFAULTS,
	type Lang,
	type RetentionPolicy,
	type TransferOptionKey,
	type TransferOptions,
} from "./contracts.ts";

// Grammar only: no environment, config, provider, filesystem, or runtime discovery here.
export class TransferOptionError extends Error {
	constructor(key: TransferOptionKey, expected: string) {
		// Values may contain credentials or private prompts; never quote a rejected value or parser error.
		super(`${key} must be ${expected}`);
		this.name = "TransferOptionError";
	}
}

export function isTransferOptionKey(key: string): key is TransferOptionKey {
	return Object.hasOwn(TRANSFER_OPTION_DEFAULTS, key);
}

export function decodeTransferOption<K extends TransferOptionKey>(key: K, input: unknown): TransferOptions[K] {
	const value = input === undefined ? TRANSFER_OPTION_DEFAULTS[key] : input;
	if (typeof value !== "string") throw new TransferOptionError(key, "a string");
	return decoders[key](value, key);
}

export function decodeTransferOptions(read: (key: TransferOptionKey) => unknown): TransferOptions {
	const entries = Object.keys(TRANSFER_OPTION_DEFAULTS).filter(isTransferOptionKey).map((key) => [key, decodeTransferOption(key, read(key))]);
	return Object.fromEntries(entries) as TransferOptions;
}

export function parseRetentionPolicy(value: string): RetentionPolicy {
	if (value === "never") return { kind: "never" };
	const days = RETENTION_DAYS.find((days) => value === `days:${days}`);
	if (days !== undefined) return { kind: "days", days };
	if (/^count:[0-9]+$/.test(value)) {
		const count = Number(value.slice("count:".length));
		if (Number.isSafeInteger(count)) return { kind: "count", count };
	}
	throw new TransferOptionError("MICME_RETENTION", `never, count:N (N a nonnegative safe integer), or ${RETENTION_DAYS.map((days) => `days:${days}`).join(", ")}`);
}

function parseChoice<T extends string>(value: string, key: TransferOptionKey, choices: readonly T[]): T {
	const choice = choices.find((choice) => choice === value);
	if (choice !== undefined) return choice;
	throw new TransferOptionError(key, choices.join(" or "));
}

function parseFlag(value: string, key: TransferOptionKey): boolean {
	return parseChoice(value, key, TRANSFER_FLAGS) === "1";
}

function isLiteral(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseSelectionId(value: string, key: TransferOptionKey): string {
	if (isLiteral(value)) return value;
	throw new TransferOptionError(key, "a nonblank ID on one line");
}

function parseList(value: string, key: TransferOptionKey): string[] {
	let items: unknown;
	try {
		items = JSON.parse(value);
	} catch {
		throw new TransferOptionError(key, 'a JSON array string, for example ["example"]');
	}
	if (!Array.isArray(items) || !items.every(isLiteral)) {
		throw new TransferOptionError(key, "a JSON array of nonblank strings without control characters");
	}
	return items;
}

function parseLanguages(value: string, key: TransferOptionKey): Lang[] {
	return parseList(value, key).map(canonicalLanguage);
}

function canonicalLanguage(value: string): Lang {
	try {
		const [canonical] = Intl.getCanonicalLocales(value);
		if (canonical && canonical !== "auto") return canonical;
	} catch {
		// Intl errors may include the invalid tag. Report the expected format instead.
	}
	throw new TransferOptionError("MICME_PREFERRED_LANGUAGES", 'a JSON array of BCP-47 language tags, for example ["en","pt-BR"] (not auto)');
}

function parseEndpoint(value: string, key: TransferOptionKey): URL | null {
	if (value === "") return null;
	const endpoint = /^https?:\/\/[^/@\s?#\\]+(?:\/[^\s?#\\]*)?$/i.test(value) && isLiteral(value) ? URL.parse(value) : null;
	if (endpoint) return endpoint;
	throw new TransferOptionError(key, "an absolute HTTP(S) base URL without credentials, query, or fragment (or an empty string)");
}

function parseKeyEnv(value: string, key: TransferOptionKey): string | null {
	if (value === "") return null;
	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
	throw new TransferOptionError(key, "an environment variable name, not a credential value (or an empty string)");
}

function parseHook(value: string, key: TransferOptionKey): string | null {
	if (value === "") return null;
	if (isLiteral(value) && posix.isAbsolute(value)) return value;
	throw new TransferOptionError(key, "an absolute path to a trusted Unix executable (or an empty string)");
}

const decoders: { [K in TransferOptionKey]: (value: string, key: K) => TransferOptions[K] } = {
	MICME_ARTIFACT: (value, key) => value === "" ? null : parseSelectionId(value, key),
	MICME_COMPUTE: parseSelectionId,
	MICME_MODEL_IDLE: (value, key) => parseChoice(value, key, MODEL_IDLE_MODES),
	MICME_CHUNKING: parseFlag,
	MICME_DETECTOR: (value, key) => parseChoice(value, key, DETECTORS),
	MICME_PREFERRED_LANGUAGES: parseLanguages,
	MICME_WORDS: parseList,
	MICME_FILLERS: parseList,
	MICME_LOCAL_LID: parseFlag,
	MICME_REMOVE_FILLERS: parseFlag,
	MICME_SCRIPT: (value, key) => parseChoice(value, key, SCRIPTS),
	MICME_HISTORY: parseFlag,
	MICME_RETENTION: parseRetentionPolicy,
	MICME_POLISH_PROVIDER: (value, key) => value === "" ? null : parseChoice(value, key, POLISH_PROVIDERS),
	MICME_POLISH_ENDPOINT: parseEndpoint,
	MICME_POLISH_MODEL: (value, key) => value === "" ? "" : parseSelectionId(value, key),
	MICME_POLISH_PROMPT: (value) => value,
	MICME_POLISH_KEY_ENV: parseKeyEnv,
	MICME_OUTPUT_HOOK: parseHook,
};
