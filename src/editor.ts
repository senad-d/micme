import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, decodeKittyPrintable } from "@earendil-works/pi-tui";
import { matchesPrintableMicmeShortcut } from "./config.ts";

type CustomEditorArgs = ConstructorParameters<typeof CustomEditor>;
// Printable Option-key fallbacks auto-repeat while held; debounce them so one hold is one toggle.
const PRINTABLE_SHORTCUT_REPEAT_GUARD_MS = 1_000;
let lastPrintableShortcut = "";
let lastPrintableShortcutAt = 0;

export type MicmeEditorInputHandlers = {
	toggle: () => Promise<void> | void;
};

class MicmeEditor extends CustomEditor {
	constructor(
		tui: CustomEditorArgs[0],
		theme: CustomEditorArgs[1],
		keybindings: CustomEditorArgs[2],
		private readonly micmeHandlers: MicmeEditorInputHandlers,
	) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		if (handleMicmeEditorInput(data, this.micmeHandlers)) return;
		super.handleInput(data);
	}
}

function handleMicmeEditorInput(data: string, handlers: MicmeEditorInputHandlers) {
	const printable = decodeKittyPrintable(data);
	const printableShortcut = matchesPrintableMicmeShortcut(data) ? data : printable !== undefined && matchesPrintableMicmeShortcut(printable) ? printable : undefined;
	if (printableShortcut !== undefined) {
		if (!isPrintableShortcutAutoRepeat(printableShortcut)) void handlers.toggle();
		return true;
	}

	return false;
}

function isPrintableShortcutAutoRepeat(printableShortcut: string) {
	const now = Date.now();
	const repeated = printableShortcut === lastPrintableShortcut && now - lastPrintableShortcutAt < PRINTABLE_SHORTCUT_REPEAT_GUARD_MS;
	lastPrintableShortcut = printableShortcut;
	lastPrintableShortcutAt = now;
	return repeated;
}

export function installMicmeEditorFallback(ctx: ExtensionContext, micmeHandlers: MicmeEditorInputHandlers) {
	if (ctx.mode !== "tui") return;

	const previousEditor = ctx.ui.getEditorComponent();
	if (previousEditor) {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const base = previousEditor(tui, theme, keybindings);
			return {
				get focused(): boolean {
					return Boolean((base as { focused?: boolean }).focused);
				},
				set focused(value: boolean) {
					if ("focused" in base) (base as { focused?: boolean }).focused = value;
				},
				get onSubmit(): ((text: string) => void) | undefined {
					return base.onSubmit;
				},
				set onSubmit(handler: ((text: string) => void) | undefined) {
					base.onSubmit = handler;
				},
				get onChange(): ((text: string) => void) | undefined {
					return base.onChange;
				},
				set onChange(handler: ((text: string) => void) | undefined) {
					base.onChange = handler;
				},
				get borderColor(): ((str: string) => string) | undefined {
					return base.borderColor;
				},
				set borderColor(handler: ((str: string) => string) | undefined) {
					base.borderColor = handler;
				},
				render(width: number) {
					return base.render(width);
				},
				invalidate() {
					base.invalidate();
				},
				getText() {
					return base.getText();
				},
				setText(text: string) {
					base.setText(text);
				},
				getExpandedText() {
					return base.getExpandedText?.() ?? base.getText();
				},
				addToHistory(text: string) {
					base.addToHistory?.(text);
				},
				insertTextAtCursor(text: string) {
					base.insertTextAtCursor?.(text);
				},
				setAutocompleteProvider(provider: AutocompleteProvider) {
					base.setAutocompleteProvider?.(provider);
				},
				setPaddingX(padding: number) {
					base.setPaddingX?.(padding);
				},
				setAutocompleteMaxVisible(maxVisible: number) {
					base.setAutocompleteMaxVisible?.(maxVisible);
				},
				handleInput(data: string) {
					if (handleMicmeEditorInput(data, micmeHandlers)) return;
					base.handleInput(data);
				},
			};
		});
		return;
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new MicmeEditor(tui, theme, keybindings, micmeHandlers));
}
