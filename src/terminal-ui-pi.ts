import { getKeybindings } from "@earendil-works/pi-tui";
import type { SelectionAction } from "./terminal-ui.ts";

export { decodeKittyPrintable, fuzzyFilter, matchesKey, parseKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
export { installLegacyEditor } from "./editor-pi.ts";

export function matchesSelectionAction(data: string, action: SelectionAction) {
	return getKeybindings().matches(data, `tui.select.${action}`);
}
