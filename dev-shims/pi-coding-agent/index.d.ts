// Development-only shim for local typechecking.
// The published extension still declares the real pi coding agent as a peer.
import {
  Editor,
  type AutocompleteProvider,
  type Component,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

export type NotificationLevel = "info" | "warning" | "error" | "success" | string;

export interface KeybindingsManager {
  matches(data: string, action: string): boolean;
}

export interface CompletionItem {
  value: string;
  label?: string;
  description?: string;
}

export interface EditorComponent extends Component {
  focused?: boolean;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  borderColor?: (value: string) => string;
  handleInput(data: string): void;
  getText(): string;
  setText(text: string): void;
  getExpandedText?(): string;
  addToHistory?(text: string): void;
  insertTextAtCursor?(text: string): void;
  setAutocompleteProvider?(provider: AutocompleteProvider): void;
  setPaddingX?(padding: number): void;
  setAutocompleteMaxVisible?(maxVisible: number): void;
}

export type EditorComponentFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

export interface ExtensionTheme {
  fg(color: string, value: string): string;
  bold(value: string): string;
}

export interface ExtensionUI {
  theme: ExtensionTheme;
  notify(message: string, level?: NotificationLevel): void;
  setStatus(key: string, value: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined): void;
  editor(title: string, content: string): void | Promise<void>;
  custom<T>(
    factory: (tui: TUI, theme: ExtensionTheme, keybindings: KeybindingsManager, done: (value?: T) => void) => Component,
  ): Promise<T>;
  getEditorText(): string;
  setEditorText(text: string): void;
  pasteToEditor(text: string): void;
  getEditorComponent(): EditorComponentFactory | undefined;
  setEditorComponent(factory: EditorComponentFactory): void;
}

export interface ExtensionContext {
  cwd: string;
  mode: string;
  ui: ExtensionUI;
  isIdle(): boolean;
}

export interface ExtensionCommandOptions {
  description?: string;
  getArgumentCompletions?(prefix: string): CompletionItem[] | null | Promise<CompletionItem[] | null>;
  handler(args: string, ctx: ExtensionContext): void | Promise<void>;
}

export interface ExtensionShortcutOptions {
  description?: string;
  handler(ctx: ExtensionContext): void | Promise<void>;
}

export interface SendUserMessageOptions {
  deliverAs?: "followUp" | string;
}

export interface ExtensionAPI {
  registerCommand(name: string, options: ExtensionCommandOptions): void;
  registerShortcut(shortcut: string, options: ExtensionShortcutOptions): void;
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
  sendUserMessage(message: string, options?: SendUserMessageOptions): void;
}

export class DynamicBorder implements Component {
  constructor(color?: (value: string) => string);
  invalidate(): void;
  render(width: number): string[];
}

export class CustomEditor extends Editor {
  actionHandlers: Map<string, () => void>;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions);
  onAction(action: string, handler: () => void): void;
  handleInput(data: string): void;
}
