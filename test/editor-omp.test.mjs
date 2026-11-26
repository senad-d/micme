import assert from "node:assert/strict";
import test from "node:test";
import { installMicmeComposerShortcut } from "../src/editor-omp.ts";

test("OMP composer consumes only the configured printable shortcut and toggles once per press", (t) => {
	const previous = process.env.MICME_SHORTCUT;
	process.env.MICME_SHORTCUT = "§";
	t.after(() => {
		if (previous === undefined) delete process.env.MICME_SHORTCUT;
		else process.env.MICME_SHORTCUT = previous;
	});
	let keyHandler;
	let toggles = 0;
	const remove = installMicmeComposerShortcut({ ui: { composer: {
		addKeyHandler(handler) {
			keyHandler = handler;
			return () => { keyHandler = undefined; };
		},
	} } }, { toggle: () => { toggles++; } });
	assert.equal(keyHandler({ kind: "press", id: "x", text: "x", raw: "x" }), false);
	const key = { id: "§", text: "§", raw: "\x1b[167u" };
	assert.equal(keyHandler({ ...key, kind: "press" }), true);
	assert.equal(keyHandler({ ...key, kind: "repeat" }), true);
	assert.equal(keyHandler({ ...key, kind: "release" }), true);
	assert.equal(toggles, 1);
	remove();
	assert.equal(keyHandler, undefined);
});
