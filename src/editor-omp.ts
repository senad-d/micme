import type { ExtensionContext as OmpContext } from "@oh-my-pi/pi-coding-agent";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesPrintableMicmeShortcut } from "./config.ts";
import type { MicmeEditorInputHandlers } from "./editor.ts";

function configuredShortcut({ raw, text }: KeyEvent) {
	if (matchesPrintableMicmeShortcut(raw)) return raw;
	return text && matchesPrintableMicmeShortcut(text) ? text : undefined;
}

export function releaseKey({ id, raw }: KeyEvent) {
	// OMP's decoded id can be the shifted symbol. A decoded Kitty CSI-u event
	// still carries the unshifted key in the first field, even on release.
	const primaryCodepoint = raw.endsWith("u") ? /^\x1b\[(\d+)/.exec(raw)?.[1] : undefined;
	if (primaryCodepoint) return Number(primaryCodepoint);
	const base = id.replace(/^(?:(?:ctrl|alt|shift|super)\+)+/, "");
	return /^.$/u.test(base) ? base.codePointAt(0) : base;
}

export function installMicmeComposerShortcut(ctx: ExtensionContext, handlers: MicmeEditorInputHandlers, decodeKey: (data: string) => KeyEvent | null) {
	// The host is selected before loading this module. Pi does not expose composer hooks.
	const { ui } = ctx as unknown as OmpContext;
	let lastShortcut: string | undefined;
	let lastKey: ReturnType<typeof releaseKey>;
	let lastAt = 0;
	const rearm = (key: KeyEvent) => {
		if (!lastShortcut || releaseKey(key) !== lastKey) return false;
		lastShortcut = undefined;
		return true;
	};
	const removeComposerHandler = ui.composer?.addKeyHandler((key) => {
		if (key.kind === "release") return rearm(key) || Boolean(configuredShortcut(key));
		const shortcut = configuredShortcut(key);
		if (!shortcut) return false;
		const now = Date.now();
		if (key.kind === "press" && (shortcut !== lastShortcut || now - lastAt >= 1_000)) void handlers.toggle();
		lastShortcut = shortcut;
		lastKey = releaseKey(key);
		lastAt = now;
		return true;
	});
	if (!removeComposerHandler) return undefined;

	// OMP 19.2 filters releases before composer dispatch. Observe them at the
	// terminal boundary without consuming input or handling presses outside the composer.
	const removeReleaseListener = ui.onTerminalInput((data) => {
		if (!lastShortcut) return;
		const key = decodeKey(data);
		if (key?.kind === "release") rearm(key);
	});
	return () => {
		removeReleaseListener();
		removeComposerHandler();
	};
}
