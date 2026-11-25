// OMP provides these modules in its binary; Micme does not bundle a second TUI runtime.
declare module "@oh-my-pi/pi-tui/driver/input/keys" {
	export function decodeKey(data: string, context: { kitty: boolean; backspaceIsCtrl: boolean }): { id: string; text?: string } | null;
}

declare module "@oh-my-pi/pi-tui/text/width" {
	export function visibleWidth(text: string): number;
	export function sliceCells(text: string, start: number, length: number, strict?: boolean): { text: string };
	export function truncate(text: string, width: number, ellipsis?: string): string;
	export function wrap(text: string, width: number): string[];
}

declare module "@oh-my-pi/pi-coding-agent/utils/fuzzy" {
	export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[];
}
