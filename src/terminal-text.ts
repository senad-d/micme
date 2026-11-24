const ESCAPE_CONTROL_CHARACTER = String.fromCodePoint(0x1B);
const BELL_CONTROL_CHARACTER = String.fromCodePoint(0x07);
const NON_PRINTABLE_CONTROL_CHARACTER_RANGES = [
	[0x00, 0x08],
	[0x0B, 0x0C],
	[0x0E, 0x1F],
	[0x7F, 0x9F],
] as const;
// DCS, SOS, OSC, PM and APC may use ESC-prefixed or C1 introducers and terminators.
// Match an unterminated tail once rather than searching it again for each introducer.
const TERMINAL_STRING_CONTROL_SEQUENCE_PATTERN = new RegExp(
	String.raw`(?:${ESCAPE_CONTROL_CHARACTER}[PX\]^_]|[\u0090\u0098\u009D-\u009F])[\s\S]*?(${BELL_CONTROL_CHARACTER}|${ESCAPE_CONTROL_CHARACTER}\\|\u009C|$)`,
	"g",
);
const CONTROL_SEQUENCE_INTRODUCER_PATTERN = new RegExp(String.raw`(?:${ESCAPE_CONTROL_CHARACTER}\[|\u009B)[0-?]*[ -/]*[@-~]`, "g");
const ESCAPE_SEQUENCE_PATTERN = new RegExp(`${ESCAPE_CONTROL_CHARACTER}[ -/]*[@-~]`, "g");
const NON_PRINTABLE_CONTROL_CHARACTER_PATTERN = new RegExp(`[${NON_PRINTABLE_CONTROL_CHARACTER_RANGES.map(formatControlCharacterRange).join("")}]`, "g");

export function stripTerminalControlSequences(value: string) {
	return value
		.replace(TERMINAL_STRING_CONTROL_SEQUENCE_PATTERN, replaceTerminalString)
		.replace(CONTROL_SEQUENCE_INTRODUCER_PATTERN, " ")
		.replace(ESCAPE_SEQUENCE_PATTERN, " ")
		.replace(NON_PRINTABLE_CONTROL_CHARACTER_PATTERN, " ");
}

function replaceTerminalString(sequence: string, terminator: string) {
	return terminator ? " " : sequence;
}

function formatControlCharacterRange(range: readonly [number, number]) {
	const [first, last] = range;
	const firstCharacter = String.fromCodePoint(first);
	const lastCharacter = String.fromCodePoint(last);
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
