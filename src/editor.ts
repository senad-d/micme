import { type AppKeybinding, CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, decodeKittyPrintable, type EditorComponent } from "@earendil-works/pi-tui";
import { getPrintableShortcuts, matchesPrintableMicmeShortcut } from "./config.ts";

type CustomEditorArgs = ConstructorParameters<typeof CustomEditor>;
// Printable Option-key fallbacks auto-repeat while held; debounce them so one hold is one toggle.
const PRINTABLE_SHORTCUT_REPEAT_GUARD_MS = 1_000;
let lastPrintableShortcut = "";
let lastPrintableShortcutAt = 0;

export type MicmeEditorInputHandlers = {
	toggle: () => Promise<void> | void;
};

type AppAwareEditor = EditorComponent & {
	actionHandlers: Map<AppKeybinding, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
};

class MicmeEditor extends CustomEditor {
	private readonly micmeHandlers: MicmeEditorInputHandlers;

	constructor(tui: CustomEditorArgs[0], theme: CustomEditorArgs[1], keybindings: CustomEditorArgs[2], micmeHandlers: MicmeEditorInputHandlers) {
		super(tui, theme, keybindings);
		this.micmeHandlers = micmeHandlers;
	}

	override handleInput(data: string): void {
		if (handleMicmeEditorInput(data, this.micmeHandlers)) return;
		super.handleInput(data);
	}
}

// Pi wires app handlers only onto the outer editor returned by the active factory.
// Keep that identity while delegating editing behavior to the previously installed editor.
class WrappedMicmeEditor extends CustomEditor {
	readonly wantsKeyRelease?: boolean;
	private readonly base: EditorComponent;
	private readonly baseAppEditor: AppAwareEditor | undefined;
	private readonly micmeHandlers: MicmeEditorInputHandlers;

	constructor(
		tui: CustomEditorArgs[0],
		theme: CustomEditorArgs[1],
		keybindings: CustomEditorArgs[2],
		base: EditorComponent,
		micmeHandlers: MicmeEditorInputHandlers,
	) {
		super(tui, theme, keybindings);
		this.base = base;
		this.baseAppEditor = getAppAwareEditor(base);
		this.micmeHandlers = micmeHandlers;
		this.wantsKeyRelease = base.wantsKeyRelease;
		this.focused = "focused" in base && Boolean(base.focused);
		this.onSubmit = base.onSubmit;
		this.onChange = base.onChange;
		if (base.borderColor !== undefined) this.borderColor = base.borderColor;
		if (this.baseAppEditor) this.adoptBaseAppHandlers(this.baseAppEditor);
	}

	override render(width: number): string[] {
		this.syncBaseEditor();
		return this.base.render(width);
	}

	override invalidate(): void {
		this.syncBaseEditor();
		this.base.invalidate();
	}

	override getText(): string {
		return this.base.getText();
	}

	override setText(text: string): void {
		this.syncBaseEditor();
		this.base.setText(text);
	}

	override getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	override addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	override insertTextAtCursor(text: string): void {
		this.syncBaseEditor();
		this.base.insertTextAtCursor?.(text);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	override setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	override setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	override handleInput(data: string): void {
		if (handleMicmeEditorInput(data, this.micmeHandlers)) return;
		this.syncBaseEditor();
		this.base.handleInput(data);
	}

	private adoptBaseAppHandlers(base: AppAwareEditor): void {
		// Sharing the map makes Pi's later handler copy immediately visible to the wrapped CustomEditor.
		this.actionHandlers = base.actionHandlers;
		this.onEscape = base.onEscape;
		this.onCtrlD = base.onCtrlD;
		this.onPasteImage = base.onPasteImage;
		this.onExtensionShortcut = base.onExtensionShortcut;
	}

	private syncBaseEditor(): void {
		if ("focused" in this.base) this.base.focused = this.focused;
		this.base.onSubmit = this.onSubmit;
		this.base.onChange = this.onChange;
		this.base.borderColor = this.borderColor;
		if (!this.baseAppEditor) return;
		this.baseAppEditor.onEscape = this.onEscape;
		this.baseAppEditor.onCtrlD = this.onCtrlD;
		this.baseAppEditor.onPasteImage = this.onPasteImage;
		this.baseAppEditor.onExtensionShortcut = this.onExtensionShortcut;
	}
}

function getAppAwareEditor(editor: EditorComponent): AppAwareEditor | undefined {
	if (!("actionHandlers" in editor) || !(editor.actionHandlers instanceof Map)) return undefined;
	return editor as AppAwareEditor;
}

function handleMicmeEditorInput(data: string, handlers: MicmeEditorInputHandlers) {
	const printable = decodeKittyPrintable(data);
	let printableShortcut: string | undefined;
	if (matchesPrintableMicmeShortcut(data)) {
		printableShortcut = data;
	} else if (printable !== undefined && matchesPrintableMicmeShortcut(printable)) {
		printableShortcut = printable;
	}
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
	if (ctx.mode !== "tui" || getPrintableShortcuts().length === 0) return;

	const previousEditor = ctx.ui.getEditorComponent();
	if (previousEditor) {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const base = previousEditor(tui, theme, keybindings);
			return new WrappedMicmeEditor(tui, theme, keybindings, base, micmeHandlers);
		});
		return;
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new MicmeEditor(tui, theme, keybindings, micmeHandlers));
}
