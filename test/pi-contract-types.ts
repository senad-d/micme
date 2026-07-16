import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

declare const pi: ExtensionAPI;
declare const ctx: ExtensionContext;

// These assertions make the contract gate fail if the real Pi declarations are
// replaced by a permissive shim or stop rejecting incompatible extension calls.
// @ts-expect-error Pi lifecycle event names are a closed contract.
pi.on("micme_invalid_event", () => undefined);

// @ts-expect-error Pi shortcuts must use a valid TUI KeyId.
pi.registerShortcut("invalid+shortcut", { handler: () => undefined });

// @ts-expect-error Pi notification levels do not include success.
ctx.ui.notify("invalid notification level", "success");

// @ts-expect-error Pi editor factories must return the full EditorComponent contract.
ctx.ui.setEditorComponent(() => ({
	invalidate() {},
	render: () => [],
}));
