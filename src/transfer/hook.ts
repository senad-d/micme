import { posix } from "node:path";
import { runTextFilter } from "../processes.ts";
import { stripTerminalControlSequences } from "../terminal-text.ts";
import { OUTPUT_HOOK_TIMEOUT_MS, type Output, type RunOutputHook } from "./contracts.ts";

export const runOutputHook: RunOutputHook = async (text, hook, signal) => {
	if (signal.aborted) return { kind: "suppressed", reason: "cancel", warnings: [] };
	const original = hookText(text);
	if (hook === null) return output(original);
	if ((process.platform !== "linux" && process.platform !== "darwin") || !posix.isAbsolute(hook) || /[\p{Cc}\p{Bidi_Control}]/u.test(hook)) {
		return output(original, [{ stage: "hook", reason: "error" }]);
	}

	try {
		const result = await runTextFilter(hook, original, OUTPUT_HOOK_TIMEOUT_MS, signal);
		if (signal.aborted || result.cancelled) return { kind: "suppressed", reason: "cancel", warnings: [] };
		if (result.timedOut) return output(original, [{ stage: "hook", reason: "timeout" }]);
		if (result.code !== 0 || result.signal || result.stdoutTruncated) return output(original, [{ stage: "hook", reason: "error" }]);
		// Keep indentation and intentional line breaks, removing one final LF.
		return output(hookText(result.stdout).replace(/\n$/, ""));
	} catch {
		if (signal.aborted) return { kind: "suppressed", reason: "cancel", warnings: [] };
		return output(original, [{ stage: "hook", reason: "error" }]);
	}
};

function hookText(text: string) {
	return stripTerminalControlSequences(text.replace(/\p{Bidi_Control}/gu, "")).replace(/\r\n?/g, "\n");
}

function output(text: string, warnings: Output["warnings"] = []): Output {
	return text.trim() ? { kind: "candidate", text, warnings } : { kind: "suppressed", reason: "empty", warnings };
}
