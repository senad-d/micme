import assert from "node:assert/strict";
import test from "node:test";

const { sanitizeTerminalOutput, sanitizeTerminalText, stripTerminalControlSequences } = await import("../src/terminal-text.ts");

const ESC = "\u001B";
const BEL = "\u0007";

test("stripTerminalControlSequences removes terminal string control sequences", () => {
	assert.equal(stripTerminalControlSequences(`keep${ESC}Pprivate${BEL} text${ESC}_hidden${ESC}\\ done`), "keep  text  done");
});

test("sanitizeTerminalText removes control sequences and normalizes whitespace", () => {
	assert.equal(sanitizeTerminalText(`hello${ESC}Pprivate${BEL}   world`), "hello world");
});

test("sanitizeTerminalOutput normalizes carriage returns", () => {
	assert.equal(sanitizeTerminalOutput("first\r\nsecond\rthird\n"), "first\nsecond\nthird");
});
