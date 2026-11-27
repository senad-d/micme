import { release } from "node:os";
import { join } from "node:path";
import { MAX_CAPTURED_OUTPUT_CHARS } from "../constants.ts";
import { runTextFilter } from "../processes.ts";
import { sanitizeTerminalOutput } from "../terminal-text.ts";
import { DEFAULT_POLISH_PROMPT, POLISH_TIMEOUT_MS, type Polish, type PolishResult, type Provider, type Selection, type Signal } from "./contracts.ts";

// Exact, documented text/chat cohorts; evidence and source links are in
// test/live-native/transfer-q-p8-provider-evidence.md. A named credential
// must never follow an endpoint override to an arbitrary compatible server.
const HOSTED = {
	openai: { base: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
	anthropic: { base: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6" },
	groq: { base: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant" },
	cerebras: { base: "https://api.cerebras.ai/v1", model: "gpt-oss-120b" },
	openrouter: { base: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" },
	zai: { base: "https://api.z.ai/api/paas/v4", model: "glm-4.7" },
} as const;

export const polish: Polish = async (final, selection, signal) => {
	signal.throwIfAborted();
	const { provider, model } = selection;
	if (provider === null || !final.local.trim()) return { text: final.local, polished: null, warning: "none" };
	const prompt = selection.prompt.trim() ? selection.prompt : DEFAULT_POLISH_PROMPT;
	if (provider === "apple-device") return polishOnDevice(final.raw, final.local, prompt, selection, signal);

	const target = httpTarget(provider, selection.endpoint, model);
	if (!target) return fallback(final.raw, "invalid");
	const key = selection.keyEnv && /^[A-Za-z_][A-Za-z0-9_]*$/.test(selection.keyEnv) ? process.env[selection.keyEnv] : undefined;
	if ((target.named || selection.keyEnv !== null) && (!key || !/^[\x21-\x7E]+$/.test(key))) return fallback(final.raw, "error");

	const timeout = AbortSignal.timeout(POLISH_TIMEOUT_MS);
	const requestSignal = AbortSignal.any([signal, timeout]);
	const messages = [{ role: "user", content: final.local }];
	const body = target.anthropic ? { model, system: prompt, messages, max_tokens: 1024, stream: false }
		: { model, messages: [{ role: "system", content: prompt }, ...messages], stream: false };
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (target.anthropic) headers["anthropic-version"] = "2023-06-01";
	if (key) headers[target.anthropic ? "x-api-key" : "Authorization"] = target.anthropic ? key : `Bearer ${key}`;

	try {
		const response = await fetch(target.url, { method: "POST", redirect: "manual", credentials: "omit", headers, body: JSON.stringify(body), signal: requestSignal });
		if (!response.ok || requestSignal.aborted) {
			void response.body?.cancel().catch(() => undefined);
			requestSignal.throwIfAborted();
			return fallback(final.raw, response.status >= 300 && response.status < 400 ? "redirect" : "error");
		}
		if (response.status === 206) {
			void response.body?.cancel().catch(() => undefined);
			return fallback(final.raw, "invalid");
		}
		const answer = await readJson(response);
		requestSignal.throwIfAborted();
		return candidate(final.raw, target.anthropic ? messagesText(answer) : chatText(answer, target.named));
	} catch {
		signal.throwIfAborted();
		return fallback(final.raw, timeout.aborted ? "timeout" : "error");
	}
};

function httpTarget(provider: Exclude<Provider, "apple-device">, endpoint: URL | null, model: string) {
	if (!endpoint || !model.trim() || model.trim() !== model || /[\p{Cc}\p{Bidi_Control}]/u.test(model)) return null;
	// Reject even empty query/fragment delimiters and never accept URL userinfo.
	if (endpoint.href !== endpoint.origin + endpoint.pathname) return null;
	const loopback = endpoint.hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(endpoint.hostname);
	if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) return null;
	if (provider === "local-openai" && !loopback) return null;
	const custom = provider === "local-openai" || provider === "custom-openai" || provider === "custom-anthropic";
	const base = endpoint.href.replace(/\/+$/, "");
	if (provider === "bedrock-mantle") {
		if (!/^https:\/\/bedrock-mantle\.[a-z]{2}(?:-[a-z]+)+-\d+\.api\.aws\/v1$/.test(base) || model !== "openai.gpt-oss-120b") return null;
	} else if (!custom) {
		const named = HOSTED[provider];
		if (base !== named.base || model !== named.model) return null;
	}
	const anthropic = provider === "anthropic" || provider === "custom-anthropic";
	return { url: `${base}/${anthropic ? "messages" : "chat/completions"}`, anthropic, named: !custom };
}

async function readJson(response: Response): Promise<unknown> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let done = false;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) { done = true; break; }
			bytes += part.value.byteLength;
			if (bytes > MAX_CAPTURED_OUTPUT_CHARS) return null;
			chunks.push(part.value);
		}
	} finally {
		if (!done) void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown;
	} catch {
		return null;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function chatText(answer: unknown, requireFinishReason: boolean) {
	const choices = record(answer)?.choices;
	const first = Array.isArray(choices) ? record(choices[0]) : undefined;
	if (!first) return null;
	// Named cohorts report completion explicitly; compatible Chat may use the
	// minimal message-content response, but an explicit partial is never final.
	const reason = first.finish_reason;
	if (reason !== "stop" && (requireFinishReason || reason !== undefined)) return null;
	const message = record(first.message);
	if (!message) return null;
	if ((message.role !== undefined && message.role !== "assistant") || message.function_call != null || message.refusal != null) return null;
	if (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length)) return null;
	return message.content;
}

function messagesText(answer: unknown) {
	const message = record(answer);
	if (!message || (message.stop_reason !== "end_turn" && message.stop_reason !== "stop_sequence") || !Array.isArray(message.content)) return null;
	if ((message.role !== undefined && message.role !== "assistant") || (message.type !== undefined && message.type !== "message")) return null;
	let text = "";
	for (const value of message.content) {
		const block = record(value);
		if (block?.type !== "text" || typeof block.text !== "string") return null;
		text += block.text;
	}
	return text;
}

async function polishOnDevice(raw: string, text: string, prompt: string, selection: Selection, signal: Signal): Promise<PolishResult> {
	if (selection.endpoint || selection.keyEnv !== null || (selection.model !== "" && selection.model !== "system")) return fallback(raw, "invalid");
	// macOS 26 starts at Darwin 25. The helper repeats the real runtime
	// availability check, including Apple Intelligence enablement/model readiness.
	if (process.platform !== "darwin" || process.arch !== "arm64" || Number.parseInt(release(), 10) < 25) return fallback(raw, "error");
	try {
		const { getMicmeAgentDir } = await import("../config.ts");
		signal.throwIfAborted();
		const helper = join(getMicmeAgentDir(), "bin", "micme-apple-final");
		const result = await runTextFilter(helper, JSON.stringify({ text, prompt }), POLISH_TIMEOUT_MS, signal);
		signal.throwIfAborted();
		if (result.timedOut) return fallback(raw, "timeout");
		if (result.code !== 0 || result.signal) return fallback(raw, "error");
		return candidate(raw, result.stdoutTruncated ? null : result.stdout);
	} catch {
		signal.throwIfAborted();
		return fallback(raw, "error");
	}
}

function candidate(raw: string, value: unknown): PolishResult {
	const text = typeof value === "string" ? sanitizeTerminalOutput(value.replace(/\p{Bidi_Control}/gu, "")) : "";
	return text ? { text, polished: text, warning: "none" } : fallback(raw, "invalid");
}

function fallback(text: string, warning: PolishResult["warning"]): PolishResult {
	return { text, polished: null, warning };
}
