import { isOmp } from "./host.ts";

// OMP's loader also scans type-only declarations for legacy TUI specifiers.
export type AutocompleteProvider = import("./terminal-ui-pi.ts").AutocompleteProvider;
export type Component = import("./terminal-ui-pi.ts").Component;
export type EditorComponent = import("./terminal-ui-pi.ts").EditorComponent;
export type SelectItem = import("./terminal-ui-pi.ts").SelectItem;
export type SettingItem = import("./terminal-ui-pi.ts").SettingItem;

// OMP scans literal imports even in inactive branches; Pi lacks OMP's modules.
const piAdapter = "./terminal-ui-pi.ts";
const adapter = isOmp ? await import("./terminal-ui-omp.ts") : await import(piAdapter) as typeof import("./terminal-ui-pi.ts");
export const {
	decodeKittyPrintable,
	fuzzyFilter,
	matchesKey,
	parseKey,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} = adapter;

// Only the Pi views use the extra keys and these components. OMP must never load the Pi adapter.
export const { Key, Container, Editor, Input, isKeyRelease, SelectList, Text } = adapter as typeof import("./terminal-ui-pi.ts");
