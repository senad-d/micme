export type AutocompleteProvider = import("./terminal-ui-pi.ts").AutocompleteProvider;
export type Component = import("./terminal-ui-pi.ts").Component;
export type EditorComponent = import("./terminal-ui-pi.ts").EditorComponent;
export type SelectItem = import("./terminal-ui-pi.ts").SelectItem;
export type SettingItem = import("./terminal-ui-pi.ts").SettingItem;

// Import this module only on a UI path. Keep the adapter outside the literal
// graph as well: upstream Pi resolves its TUI through its normal loader.
const piAdapter = "./terminal-ui-pi.ts";

export const {
	Container,
	Editor,
	Key,
	SelectList,
	Text,
	decodeKittyPrintable,
	fuzzyFilter,
	isKeyRelease,
	matchesKey,
	parseKey,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} = await import(piAdapter) as typeof import("./terminal-ui-pi.ts");
