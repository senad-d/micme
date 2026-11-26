import type { ExtensionContext as OmpContext } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesPrintableMicmeShortcut } from "./config.ts";
import type { MicmeEditorInputHandlers } from "./editor.ts";

export function installMicmeComposerShortcut(ctx: ExtensionContext, handlers: MicmeEditorInputHandlers) {
	// The host is selected before loading this module. Pi does not expose composer hooks.
	const { ui } = ctx as unknown as OmpContext;
	let lastShortcut: string | undefined;
	let lastAt = 0;
	return ui.composer?.addKeyHandler((key) => {
		const shortcut = matchesPrintableMicmeShortcut(key.raw) ? key.raw : key.text;
		if (!shortcut || !matchesPrintableMicmeShortcut(shortcut)) return false;
		if (key.kind !== "release") {
			const now = Date.now();
			if (key.kind === "press" && (shortcut !== lastShortcut || now - lastAt >= 1_000)) void handlers.toggle();
			lastShortcut = shortcut;
			lastAt = now;
		}
		return true;
	});
}
