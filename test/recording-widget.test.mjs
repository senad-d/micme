import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import test from "node:test";

import { RECORDING_WIDGET_KEY } from "../src/constants.ts";
import { RecordingWidget } from "../src/recording-widget.ts";

function createWidgetHarness(mode = "rpc") {
	const widget = new RecordingWidget();
	const widgets = new Map();
	const ctx = {
		mode,
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget(key, lines) {
				widgets.set(key, lines);
			},
		},
	};
	return {
		start: (active = { startedAt: Date.now(), audioLevel: () => 0.5 }) => widget.start(ctx, active),
		clear: () => widget.clear(ctx),
		lines: () => widgets.get(RECORDING_WIDGET_KEY),
		line: () => widgets.get(RECORDING_WIDGET_KEY)?.[0],
	};
}

test("stopping either recording widget leaves the other session's clock ticking", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const first = createWidgetHarness();
	const second = createWidgetHarness();
	first.start();
	second.start();

	t.mock.timers.tick(1_200);
	assert.match(first.line(), /00:00:01/);
	assert.match(second.line(), /00:00:01/);

	first.clear();
	t.mock.timers.tick(1_200);
	assert.equal(first.line(), undefined);
	assert.match(second.line(), /00:00:02/);

	first.start();
	second.clear();
	t.mock.timers.tick(1_200);
	assert.match(first.line(), /00:00:01/);
	assert.equal(second.line(), undefined);

	first.clear();
});

test("RPC widget replaces and clears its draft without writing editor or status", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const harness = createWidgetHarness();
	const active = { startedAt: Date.now(), audioLevel: () => 0.5 };
	t.after(harness.clear);
	harness.start(active);
	assert.equal(harness.lines().length, 1);

	active.liveDraft = "first guess";
	t.mock.timers.tick(120);
	assert.deepEqual(harness.lines().slice(1), ["Live: first guess"]);
	active.liveDraft = "revised words\n\x1b]52;c;injected\x07\x1b[31m你好\x1b[0m";
	t.mock.timers.tick(120);
	assert.deepEqual(harness.lines().slice(1), ["Live: revised words 你好"]);

	active.liveDraft = "\r \x1b[0m";
	t.mock.timers.tick(120);
	assert.equal(harness.lines().length, 1);
	harness.clear();
	active.liveDraft = "late guess";
	t.mock.timers.tick(120);
	assert.equal(harness.lines(), undefined);
});

test("TUI resizes the single-line draft to preserve its Unicode tail without changing the source", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const harness = createWidgetHarness("tui");
	const liveDraft = "Words at the start of this hypothesis with a wide family 👨‍👩‍👧 and the newest 字字 from Café";
	const active = { startedAt: Date.now(), audioLevel: () => 0.5, liveDraft };
	const stdout = process.stdout;
	const descriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
	t.after(() => {
		harness.clear();
		if (descriptor) Object.defineProperty(stdout, "columns", descriptor);
		else delete stdout.columns;
	});
	Object.defineProperty(stdout, "columns", { configurable: true, value: 40 });
	harness.start(active);
	const narrow = harness.lines()[1];
	assert.ok(visibleWidth(narrow) <= 38, "Pi adds one cell of padding on each side");
	assert.match(narrow, /^Live: …[\s\S]*newest 字字 from Café$/u);
	assert.ok(!narrow.includes("Words at the start"));

	Object.defineProperty(stdout, "columns", { configurable: true, value: 100 });
	t.mock.timers.tick(120);
	assert.equal(harness.lines()[1], `Live: ${liveDraft}`);
	assert.equal(active.liveDraft, liveDraft);
});

test("a zero live PCM reading never reopens the spool file for metering", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const harness = createWidgetHarness();
	const openFile = t.mock.fn();
	t.after(harness.clear);
	harness.start({ startedAt: Date.now(), audioPath: "raw.wav", directory: { openFile }, audioLevel: () => 0, livePcmMeter: true });
	t.mock.timers.tick(120);
	assert.match(harness.line(), /▁{13}/);
	assert.equal(openFile.mock.callCount(), 0);
});
