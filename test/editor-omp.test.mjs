import assert from "node:assert/strict";
import test from "node:test";
import { installMicmeComposerShortcut } from "../src/editor-omp.ts";

const shortcutPress = { kind: "press", id: "§", text: "§", raw: "\x1b[167u" };
const shortcutRelease = { ...shortcutPress, kind: "release", raw: "\x1b[167;1:3u" };
// On a German keyboard, Shift+3 types §. Shift is lifted before the 3 key.
const shiftedPress = { ...shortcutPress, raw: "\x1b[51:167;2:1;167u" };
const shiftedRelease = { kind: "release", id: "3", text: "3", raw: "\x1b[51;1:3u" };

function registerComposer(t) {
	const previous = process.env.MICME_SHORTCUT;
	process.env.MICME_SHORTCUT = "§";
	t.after(() => {
		if (previous === undefined) delete process.env.MICME_SHORTCUT;
		else process.env.MICME_SHORTCUT = previous;
	});
	let keyHandler;
	let inputListener;
	let toggles = 0;
	const ui = {
		composer: {
			addKeyHandler(handler) {
				keyHandler = handler;
				return () => { keyHandler = undefined; };
			},
		},
		onTerminalInput(listener) {
			inputListener = listener;
			return () => { inputListener = undefined; };
		},
	};
	const decodeKey = (raw) => [shortcutRelease, shiftedRelease].find((key) => key.raw === raw) ?? null;
	const remove = installMicmeComposerShortcut({ ui }, { toggle: () => { toggles++; } }, decodeKey);
	return {
		get keyHandler() { return keyHandler; },
		get inputListener() { return inputListener; },
		get toggles() { return toggles; },
		remove,
	};
}

test("OMP composer consumes only the configured printable shortcut and ignores repeats", (t) => {
	const composer = registerComposer(t);
	assert.equal(composer.keyHandler({ kind: "press", id: "x", text: "x", raw: "x" }), false);
	assert.equal(composer.keyHandler(shortcutPress), true);
	assert.equal(composer.keyHandler({ ...shortcutPress, kind: "repeat" }), true);
	assert.equal(composer.toggles, 1);
	composer.remove();
	assert.equal(composer.keyHandler, undefined);
	assert.equal(composer.inputListener, undefined);
});

test("OMP composer toggles again on a quick second tap after a terminal release", (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const composer = registerComposer(t);
	assert.equal(composer.keyHandler(shortcutPress), true);
	// OMP 19.2 does not send release events to composer key handlers.
	assert.equal(composer.inputListener?.(shortcutRelease.raw), undefined);
	t.mock.timers.tick(100);
	assert.equal(composer.keyHandler(shortcutPress), true);
	assert.equal(composer.toggles, 2);
});

for (const route of ["terminal", "composer"]) {
	test(`OMP ${route} release rearms a shifted shortcut even when its typed text changes`, (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		const composer = registerComposer(t);
		const release = route === "terminal" ? (key) => composer.inputListener(key.raw) : composer.keyHandler;
		composer.keyHandler(shiftedPress);
		release(shortcutRelease); // Same text, but a different physical key.
		t.mock.timers.tick(850);
		composer.keyHandler(shiftedPress);
		assert.equal(composer.toggles, 1);
		release(shiftedRelease);
		composer.keyHandler(shiftedPress);
		assert.equal(composer.toggles, 2);
	});
}
