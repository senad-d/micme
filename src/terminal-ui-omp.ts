import { fuzzyFilter } from "@oh-my-pi/pi-coding-agent/utils/fuzzy";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { sliceCells, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";

export { canonicalKeyId } from "@oh-my-pi/pi-coding-agent/config/keybindings/key-id";
export { fuzzyFilter, truncate as truncateToWidth, visibleWidth, wrap as wrapTextWithAnsi };

export function sliceByColumn(text: string, start: number, width: number, strict = false) {
	return sliceCells(text, start, width, strict).text;
}

export const Key = {
	tab: "tab", up: "up", down: "down", enter: "enter", space: "space",
	escape: "escape", backspace: "backspace", delete: "delete", slash: "/",
} as const;

export function decodeTerminalKey(data: string) {
	return decodeKey(data, { kitty: true, backspaceIsCtrl: false });
}

export function matchesKey(data: string, id: string) {
	const key = decodeTerminalKey(data);
	return key !== null && key.kind !== "release" && key.id === id;
}

export function parseKey(data: string) {
	const key = decodeTerminalKey(data);
	return key?.kind === "release" ? undefined : key?.id;
}

export function decodeKittyPrintable(data: string) {
	const key = decodeTerminalKey(data);
	return key?.kind === "release" ? undefined : key?.text;
}
