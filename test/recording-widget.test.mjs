import assert from "node:assert/strict";
import test from "node:test";

import { RECORDING_WIDGET_KEY } from "../src/constants.ts";
import { RecordingWidget } from "../src/recording-widget.ts";

function createWidgetHarness() {
	const widget = new RecordingWidget();
	const widgets = new Map();
	const ctx = {
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget(key, lines) {
				widgets.set(key, lines);
			},
		},
	};
	return {
		start: () => widget.start(ctx, { startedAt: Date.now(), audioLevel: () => 0.5 }),
		clear: () => widget.clear(ctx),
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
