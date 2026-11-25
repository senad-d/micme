import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPrintableShortcuts, matchesPrintableMicmeShortcut } from "./config.ts";
import { decodeKittyPrintable, installLegacyEditor } from "./terminal-ui.ts";

// Printable Option-key fallbacks auto-repeat while held; debounce them so one hold is one toggle.
const PRINTABLE_SHORTCUT_REPEAT_GUARD_MS = 1_000;

export type MicmeEditorInputHandlers = {
	toggle: () => Promise<void> | void;
};

type ComposerKey = { kind: "press" | "repeat" | "release"; text?: string };
type ComposerUI = { composer?: { addKeyHandler(handler: (key: ComposerKey) => boolean): () => void } };

class PrintableShortcut {
	private lastShortcut = "";
	private lastAt = 0;
	private readonly handlers: MicmeEditorInputHandlers;

	constructor(handlers: MicmeEditorInputHandlers) {
		this.handlers = handlers;
	}

	handle(shortcut: string | undefined, kind?: ComposerKey["kind"]) {
		if (shortcut === undefined || !matchesPrintableMicmeShortcut(shortcut)) return false;
		if (kind === "repeat") return true;
		if (kind === "release") {
			if (this.lastShortcut === shortcut) this.lastShortcut = "";
			return false;
		}
		// Pi and terminals without explicit repeat events still need the time guard.
		const now = Date.now();
		const repeated = this.lastShortcut === shortcut && now - this.lastAt < PRINTABLE_SHORTCUT_REPEAT_GUARD_MS;
		this.lastShortcut = shortcut;
		this.lastAt = now;
		if (!repeated) void this.handlers.toggle();
		return true;
	}
}

export function installMicmeEditorFallback(ctx: ExtensionContext, handlers: MicmeEditorInputHandlers) {
	if (ctx.mode !== "tui" || getPrintableShortcuts().length === 0) return;

	const input = new PrintableShortcut(handlers);
	const { composer } = ctx.ui as ExtensionContext["ui"] & ComposerUI;
	if (composer) return composer.addKeyHandler((key) => input.handle(key.text, key.kind));

	installLegacyEditor?.(ctx, (data) => input.handle(data) || input.handle(decodeKittyPrintable(data)));
}
