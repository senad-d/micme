import type { EntryId, Output, ProcessFinal, Signal, Warn } from "./contracts.ts";
import { runOutputHook } from "./hook.ts";
import { polish } from "./provider.ts";

export const processFinal: ProcessFinal = async (final, input, selection, signal) => {
	if (signal.aborted) return cancelled();
	if (final.source !== (input.mode === "pending-clip" ? "clip" : "live")) return { kind: "suppressed", reason: "empty", warnings: [] };

	try {
		const prepared = input.mode === "pending-clip" ? input.prepared : await polish(final, selection, signal);
		signal.throwIfAborted();
		if (input.mode === "live-preview" && input.row !== null && prepared.polished !== null) {
			await rememberPreview(input.row, prepared.polished, signal);
			signal.throwIfAborted();
		}
		// A pending clip was already saved/pruned by its owner. In particular,
		// no row after count:0 is expected and does not prevent this hook.
		const result = await runOutputHook(prepared.text, selection.hook, signal);
		if (signal.aborted) return cancelled();
		const warnings: Warn[] = prepared.warning === "none" ? [] : [{ stage: "polish", reason: prepared.warning }];
		return { ...result, warnings: [...warnings, ...result.warnings] };
	} catch (error) {
		if (signal.aborted) return cancelled();
		throw error;
	}
};

async function rememberPreview(row: EntryId, polished: string, signal: Signal) {
	try {
		const { updateTake } = await import("./library.ts");
		signal.throwIfAborted();
		// Library update opens only a surviving enabled store and is a no-op
		// for a row removed during review. Preview does not depend on storage.
		await updateTake(row, { polished }, signal);
	} catch {
		// Optional history cannot suppress an otherwise usable preview.
	}
}

function cancelled(): Output {
	return { kind: "suppressed", reason: "cancel", warnings: [] };
}
