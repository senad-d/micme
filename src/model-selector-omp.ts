import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem } from "./terminal-ui.ts";
import { getKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { decodeTerminalKey, fuzzyFilter, truncateToWidth } from "./terminal-ui-omp.ts";

export function createOmpModelSelector(items: SelectItem[], theme: ExtensionContext["ui"]["theme"], done: (value?: string) => void): Component {
	let query = "";
	let visible = items;
	let selected = 0;
	const keys = getKeybindings();
	return {
		render(width) {
			const start = Math.max(0, Math.min(selected - 7, visible.length - 16));
			const rows = [theme.fg("accent", "─ Select whisper.cpp model ─"), "✓ found locally • ○ missing; selecting downloads automatically when enabled"];
			for (let i = start; i < Math.min(start + 16, visible.length); i++) {
				const item = visible[i]!;
				const row = `${i === selected ? "›" : " "} ${item.label}  ${item.description ?? ""}`;
				rows.push(i === selected ? theme.fg("accent", row) : row);
			}
			if (!visible.length) rows.push(theme.fg("warning", "No matching models"));
			rows.push(theme.fg("dim", "↑↓ navigate • type to search • enter select • esc back"));
			return rows.map((row) => truncateToWidth(row, width, ""));
		},
		invalidate() {},
		handleInput(data) {
			const key = decodeTerminalKey(data);
			if (!key || key.kind === "release") return;
			if (keys.matches(key, "tui.select.cancel")) return done();
			if (keys.matches(key, "tui.select.confirm")) {
				const item = visible[selected];
				if (item) done(item.value);
				return;
			}
			const step = keys.matches(key, "tui.select.up") ? -1 : keys.matches(key, "tui.select.down") ? 1 : 0;
			if (step) {
				if (visible.length) selected = (selected + step + visible.length) % visible.length;
				return;
			}
			if (key.id === "backspace") query = Array.from(query).slice(0, -1).join("");
			else if (key.text) query += key.text;
			else return;
			visible = fuzzyFilter(items, query, (item) => `${item.label} ${item.description ?? ""}`);
			selected = 0;
		},
	};
}
