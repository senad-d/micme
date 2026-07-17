import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

const { reloadMicmeConfig } = await import("../src/config.ts");
const { installMicmeEditorFallback } = await import("../src/editor.ts");

const PRINTABLE_SHORTCUT_ENV = {
	MICME_SHORTCUT: "§",
	MICME_PRINTABLE_SHORTCUTS: "",
};
const APP_INPUTS = ["ctrl+l", "ctrl+p", "ctrl+t", "shift+tab", "escape", "ctrl+d", "alt+v", "extension-shortcut"];
const EXPECTED_APP_HITS = [
	"app.model.select",
	"app.model.cycleForward",
	"app.thinking.toggle",
	"app.thinking.cycle",
	"app.interrupt",
	"app.exit",
	"app.clipboard.pasteImage",
	"extension-shortcut",
];
const keyByAction = new Map([
	["app.interrupt", "escape"],
	["app.exit", "ctrl+d"],
	["app.thinking.cycle", "shift+tab"],
	["app.model.cycleForward", "ctrl+p"],
	["app.model.select", "ctrl+l"],
	["app.thinking.toggle", "ctrl+t"],
	["app.clipboard.pasteImage", "alt+v"],
]);

let installedFactory;
let previousEditor;
let submittedText;
let toggleCount;
let appHits;

function identityText(text) {
	return text;
}

function matchesKeybinding(data, action) {
	return keyByAction.get(action) === data;
}

function requestRender() {}

const theme = {
	borderColor: identityText,
	selectList: {},
};
const keybindings = { matches: matchesKeybinding };
const tui = { requestRender };

class PreviousCustomEditor extends CustomEditor {
	customInputCount = 0;
	submitInputCount = 0;

	handleInput(data) {
		if (data === "?") {
			this.customInputCount += 1;
			return;
		}
		if (data === "submit") {
			this.submitInputCount += 1;
			this.onSubmit?.(this.getText());
			return;
		}
		super.handleInput(data);
	}
}

function createPreviousEditor(editorTui, editorTheme, editorKeybindings) {
	previousEditor = new PreviousCustomEditor(editorTui, editorTheme, editorKeybindings);
	return previousEditor;
}

function getEditorComponent() {
	return createPreviousEditor;
}

function setEditorComponent(factory) {
	installedFactory = factory;
}

const ctx = {
	mode: "tui",
	ui: { getEditorComponent, setEditorComponent },
};

function toggle() {
	toggleCount += 1;
}

const micmeHandlers = { toggle };

function recordThinkingCycle() {
	appHits.push("app.thinking.cycle");
}

function recordModelCycleForward() {
	appHits.push("app.model.cycleForward");
}

function recordModelSelect() {
	appHits.push("app.model.select");
}

function recordThinkingToggle() {
	appHits.push("app.thinking.toggle");
}

function recordInterrupt() {
	appHits.push("app.interrupt");
}

function recordExit() {
	appHits.push("app.exit");
}

function recordPasteImage() {
	appHits.push("app.clipboard.pasteImage");
}

function recordExtensionShortcut(data) {
	if (data !== "extension-shortcut") return false;
	appHits.push("extension-shortcut");
	return true;
}

function recordSubmission(text) {
	submittedText = text;
}

function wirePiHandlers(editor) {
	editor.actionHandlers.set("app.thinking.cycle", recordThinkingCycle);
	editor.actionHandlers.set("app.model.cycleForward", recordModelCycleForward);
	editor.actionHandlers.set("app.model.select", recordModelSelect);
	editor.actionHandlers.set("app.thinking.toggle", recordThinkingToggle);
	editor.onEscape = recordInterrupt;
	editor.onCtrlD = recordExit;
	editor.onPasteImage = recordPasteImage;
	editor.onExtensionShortcut = recordExtensionShortcut;
}

async function withEnv(values, run) {
	const previous = new Map();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	reloadMicmeConfig();
	try {
		return await run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		reloadMicmeConfig();
	}
}

function runWrappedCustomEditorScenario() {
	installedFactory = undefined;
	previousEditor = undefined;
	submittedText = undefined;
	toggleCount = 0;
	appHits = [];

	installMicmeEditorFallback(ctx, micmeHandlers);
	assert.ok(installedFactory);
	const editor = installedFactory(tui, theme, keybindings);
	assert.ok(editor instanceof CustomEditor);
	assert.ok(previousEditor instanceof PreviousCustomEditor);
	assert.equal(editor.actionHandlers, previousEditor.actionHandlers);

	wirePiHandlers(editor);
	for (const input of APP_INPUTS) editor.handleInput(input);
	assert.deepEqual(appHits, EXPECTED_APP_HITS);

	editor.onSubmit = recordSubmission;
	editor.setText("draft");
	editor.handleInput("submit");
	editor.handleInput("?");
	editor.handleInput("§");

	assert.equal(submittedText, "draft");
	assert.equal(previousEditor.submitInputCount, 1);
	assert.equal(previousEditor.customInputCount, 1);
	assert.equal(toggleCount, 1);
}

async function testWrappedCustomEditor() {
	await withEnv(PRINTABLE_SHORTCUT_ENV, runWrappedCustomEditorScenario);
}

test("wrapped CustomEditor keeps Pi app shortcuts and the previous editor behavior", testWrappedCustomEditor);
