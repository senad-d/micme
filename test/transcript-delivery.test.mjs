import assert from "node:assert/strict";
import test from "node:test";

const { reloadMicmeConfig } = await import("../src/config.ts");
const { pasteOrSubmitTranscript } = await import("../src/transcript-delivery.ts");

function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	reloadMicmeConfig();
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		reloadMicmeConfig();
	}
}

function createHarness({ idle = true } = {}) {
	const pasted = [];
	const sent = [];
	const notifications = [];
	const ctx = {
		isIdle: () => idle,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			pasteToEditor(text) {
				pasted.push(text);
			},
		},
	};
	const pi = {
		sendUserMessage(message, options) {
			sent.push({ message, options });
		},
	};
	return { ctx, pi, pasted, sent, notifications };
}

test("pasteOrSubmitTranscript pastes normalized text for review by default", async () => {
	await withEnv({ MICME_AUTO_SUBMIT: "0" }, async () => {
		const harness = createHarness();
		await pasteOrSubmitTranscript(harness.ctx, harness.pi, " hello\nworld ");

		assert.deepEqual(harness.pasted, ["hello world "]);
		assert.deepEqual(harness.sent, []);
		assert.deepEqual(harness.notifications, []);
	});
});

test("pasteOrSubmitTranscript sends immediately when auto-submit is enabled and pi is idle", async () => {
	await withEnv({ MICME_AUTO_SUBMIT: "1" }, async () => {
		const harness = createHarness({ idle: true });
		await pasteOrSubmitTranscript(harness.ctx, harness.pi, "ship it");

		assert.deepEqual(harness.sent, [{ message: "ship it", options: undefined }]);
		assert.deepEqual(harness.pasted, []);
	});
});

test("pasteOrSubmitTranscript queues follow-up when auto-submit runs during an active turn", async () => {
	await withEnv({ MICME_AUTO_SUBMIT: "1" }, async () => {
		const harness = createHarness({ idle: false });
		await pasteOrSubmitTranscript(harness.ctx, harness.pi, "follow up");

		assert.deepEqual(harness.sent, [{ message: "follow up", options: { deliverAs: "followUp" } }]);
		assert.deepEqual(harness.pasted, []);
		assert.deepEqual(harness.notifications, [{ message: "Micme transcript queued as a follow-up message.", level: "info" }]);
	});
});
