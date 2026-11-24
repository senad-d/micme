import assert from "node:assert/strict";
import test from "node:test";

const { sanitizeTerminalOutput, sanitizeTerminalText, stripTerminalControlSequences } = await import("../src/terminal-text.ts");

const ESC = "\u001B";
const BEL = "\u0007";

test("stripTerminalControlSequences removes terminal string control sequences", () => {
	assert.equal(stripTerminalControlSequences(`keep${ESC}Pprivate${BEL} text${ESC}_hidden${ESC}\\ done`), "keep  text  done");
});

test("stripTerminalControlSequences removes a C1 CSI with its parameters and intermediate bytes", () => {
	assert.equal(stripTerminalControlSequences("left\u009B1;2 qright"), "left right");
});

test("stripTerminalControlSequences removes C1 strings and accepts either form of their terminator", () => {
	const strings = [
		`${ESC}]osc\u009C`,
		`\u0090dcs${ESC}\\`,
		"\u0098sos\u009C",
		`\u009Dosc${BEL}`,
		"\u009Epm\u009C",
		"\u009Fapc\u009C",
	];
	const text = `first${strings.join("middle")}last`;
	assert.equal(stripTerminalControlSequences(text), "first middle middle middle middle middle last");
});

test("stripTerminalControlSequences replaces standalone C1 controls without changing printable text", () => {
	assert.equal(stripTerminalControlSequences("a\u0080b\u0085c\u009Cd\u00A0é"), "a b c d\u00A0é");
});

test("sanitizeTerminalText removes control sequences and normalizes whitespace", () => {
	assert.equal(sanitizeTerminalText(`hello${ESC}Pprivate${BEL}   world`), "hello world");
});

test("sanitizeTerminalOutput normalizes carriage returns", () => {
	assert.equal(sanitizeTerminalOutput("first\r\nsecond\rthird\n"), "first\nsecond\nthird");
});
