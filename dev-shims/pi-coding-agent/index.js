// Development-only shim for local typechecking/runtime smoke tests.
// The published extension still declares the real pi coding agent as a peer.
import { Editor } from "@earendil-works/pi-tui";

export class DynamicBorder {
  constructor(color = (value) => value) {
    this.color = color;
  }

  invalidate() {}

  render(width) {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

export class CustomEditor extends Editor {
  actionHandlers = new Map();
  onEscape;
  onCtrlD;
  onPasteImage;
  onExtensionShortcut;

  constructor(tui, theme, keybindings, options) {
    super(tui, theme, options);
    this.keybindings = keybindings;
  }

  onAction(action, handler) {
    this.actionHandlers.set(action, handler);
  }

  handleInput(data) {
    super.handleInput(data);
  }
}
