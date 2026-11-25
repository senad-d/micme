import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SHORTCUT } from "./constants.ts";

export type TerminalRows = {
	render(width: number): readonly string[];
	invalidate(): void;
	handleInput?(data: string): void;
};

export type SelectionAction = "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel";

type TerminalUI = Pick<typeof import("./terminal-ui-pi.ts"),
	"decodeKittyPrintable" | "fuzzyFilter" | "matchesKey" | "matchesSelectionAction" | "parseKey" | "sliceByColumn" | "truncateToWidth" | "visibleWidth" | "wrapTextWithAnsi"
> & { installLegacyEditor?: (ctx: ExtensionContext, handleInput: (data: string) => boolean) => void };

async function loadTerminalUI(): Promise<{ kind: "omp" | "pi"; ui: TerminalUI }> {
	if (process.versions.bun) {
		try {
			return { kind: "omp", ui: await import("./terminal-ui-omp.ts") };
		} catch (error) {
			// A standalone Bun run or older Pi-derived host may not provide the reactive OMP modules.
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_MODULE_NOT_FOUND") throw error;
		}
	}
	// The Pi-only graph imports legacy components. Don't put it in the OMP loader's
	// static graph: OMP validates even imports in branches that never execute.
	const piAdapter = "./terminal-ui-pi.ts";
	return { kind: "pi", ui: await import(piAdapter) as typeof import("./terminal-ui-pi.ts") };
}

const terminal = await loadTerminalUI();
// OMP reserves Alt+M for itself. Leave explicit user settings alone.
export const terminalDefaultShortcut = terminal.kind === "omp" ? "alt+shift+m" : DEFAULT_SHORTCUT;
export const { decodeKittyPrintable, fuzzyFilter, installLegacyEditor, matchesKey, matchesSelectionAction, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } = terminal.ui;

// OMP's rows API passes only raw bytes, not the KeyEvent or terminal mode.
// ESC B/F can be Alt+Left/Right or Alt+Shift+B/F, and BS can be Ctrl+Backspace.
const AMBIGUOUS_OMP_SHORTCUT_BYTES = new Set(["\x1bB", "\x1bF", "\x08"]);

/** Return null for input whose canonical chord can't be determined from the raw bytes. */
export function parseShortcutKey(data: string, ui: ExtensionContext["ui"]): string | undefined | null {
	if ("composer" in ui && ui.composer && AMBIGUOUS_OMP_SHORTCUT_BYTES.has(data)) return null;
	return terminal.ui.parseKey(data);
}
