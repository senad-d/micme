const ESCAPE_CONTROL_CHARACTER = String.fromCharCode(0x1B);
const BELL_CONTROL_CHARACTER = String.fromCharCode(0x07);
const NON_PRINTABLE_CONTROL_CHARACTER_RANGES = [
	[0x00, 0x08],
	[0x0B, 0x0C],
	[0x0E, 0x1F],
	[0x7F, 0x7F],
] as const;
const OPERATING_SYSTEM_COMMAND_SEQUENCE_PATTERN = new RegExp(
	`${ESCAPE_CONTROL_CHARACTER}\\][^${BELL_CONTROL_CHARACTER}]*(?:${BELL_CONTROL_CHARACTER}|${ESCAPE_CONTROL_CHARACTER}\\\\)`,
	"g",
);
const TERMINAL_STRING_CONTROL_SEQUENCE_PATTERN = new RegExp(
	`${ESCAPE_CONTROL_CHARACTER}[PX^_][\\s\\S]*?(?:${BELL_CONTROL_CHARACTER}|${ESCAPE_CONTROL_CHARACTER}\\\\)`,
	"g",
);
const CONTROL_SEQUENCE_INTRODUCER_PATTERN = new RegExp(`${ESCAPE_CONTROL_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, "g");
const ESCAPE_SEQUENCE_PATTERN = new RegExp(`${ESCAPE_CONTROL_CHARACTER}[ -/]*[@-~]`, "g");
const NON_PRINTABLE_CONTROL_CHARACTER_PATTERN = new RegExp(`[${NON_PRINTABLE_CONTROL_CHARACTER_RANGES.map(formatControlCharacterRange).join("")}]`, "g");

export function stripTerminalControlSequences(value: string) {
	return value
		.replace(OPERATING_SYSTEM_COMMAND_SEQUENCE_PATTERN, " ")
		.replace(TERMINAL_STRING_CONTROL_SEQUENCE_PATTERN, " ")
		.replace(CONTROL_SEQUENCE_INTRODUCER_PATTERN, " ")
		.replace(ESCAPE_SEQUENCE_PATTERN, " ")
		.replace(NON_PRINTABLE_CONTROL_CHARACTER_PATTERN, " ");
}

function formatControlCharacterRange(range: readonly [number, number]) {
	const [first, last] = range;
	const firstCharacter = String.fromCharCode(first);
	const lastCharacter = String.fromCharCode(last);
	return first === last ? firstCharacter : `${firstCharacter}-${lastCharacter}`;
}

export function sanitizeTerminalText(value: string) {
	return stripTerminalControlSequences(value).replace(/\s+/g, " ").trim();
}

export function sanitizeTerminalOutput(value: string) {
	return stripTerminalControlSequences(value)
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}
