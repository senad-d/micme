import { type AppKeybinding, CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorComponent } from "@earendil-works/pi-tui";

type CustomEditorArgs = ConstructorParameters<typeof CustomEditor>;
type InputHandler = (data: string) => boolean;

type AppAwareEditor = EditorComponent & {
	actionHandlers: Map<AppKeybinding, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
};

class MicmeEditor extends CustomEditor {
	private readonly micmeInput: InputHandler;

	constructor(tui: CustomEditorArgs[0], theme: CustomEditorArgs[1], keybindings: CustomEditorArgs[2], micmeInput: InputHandler) {
		super(tui, theme, keybindings);
		this.micmeInput = micmeInput;
	}

	override handleInput(data: string): void {
		if (this.micmeInput(data)) return;
		super.handleInput(data);
	}
}

// Pi wires app handlers only onto the outer editor returned by the active factory.
// Keep that identity while delegating editing behavior to the previously installed editor.
class WrappedMicmeEditor extends CustomEditor {
	readonly wantsKeyRelease?: boolean;
	private readonly base: EditorComponent;
	private readonly baseAppEditor: AppAwareEditor | undefined;
	private readonly micmeInput: InputHandler;

	constructor(
		tui: CustomEditorArgs[0],
		theme: CustomEditorArgs[1],
		keybindings: CustomEditorArgs[2],
		base: EditorComponent,
		micmeInput: InputHandler,
	) {
		super(tui, theme, keybindings);
		this.base = base;
		this.baseAppEditor = getAppAwareEditor(base);
		this.micmeInput = micmeInput;
		this.wantsKeyRelease = base.wantsKeyRelease;
		this.focused = "focused" in base && Boolean(base.focused);
		this.onSubmit = base.onSubmit;
		this.onChange = base.onChange;
		if (base.borderColor !== undefined) this.borderColor = base.borderColor;
		if (this.baseAppEditor) this.adoptBaseAppHandlers(this.baseAppEditor);
	}

	override render(width: number): string[] {
		this.syncBaseEditor();
		// Pi components may reuse readonly render output; CustomEditor promises a mutable array.
		return [...this.base.render(width)];
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
		if (this.micmeInput(data)) return;
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

export function installLegacyEditor(ctx: ExtensionContext, handleInput: InputHandler) {
	const previousEditor = ctx.ui.getEditorComponent();
	if (previousEditor) {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const base = previousEditor(tui, theme, keybindings);
			return new WrappedMicmeEditor(tui, theme, keybindings, base, handleInput);
		});
		return;
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new MicmeEditor(tui, theme, keybindings, handleInput));
}
