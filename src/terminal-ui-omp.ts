import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { sliceCells, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { SelectionAction } from "./terminal-ui.ts";

export { fuzzyFilter } from "@oh-my-pi/pi-coding-agent/utils/fuzzy";
export { truncate as truncateToWidth, visibleWidth, wrap as wrapTextWithAnsi };

export function sliceByColumn(text: string, start: number, length: number, strict?: boolean) {
	return sliceCells(text, start, length, strict).text;
}

const keyContext = { kitty: true, backspaceIsCtrl: false };

export function parseKey(data: string) {
	return decodeKey(data, keyContext)?.id;
}

export function matchesKey(data: string, id: string) {
	return parseKey(data) === id;
}

export function matchesSelectionAction(data: string, action: SelectionAction) {
	if (action === "cancel") return matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
	return matchesKey(data, action === "confirm" ? "enter" : action);
}

export function decodeKittyPrintable(data: string) {
	return data.startsWith("\x1b[") ? decodeKey(data, keyContext)?.text : undefined;
}
