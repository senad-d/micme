import assert from "node:assert/strict";
import test from "node:test";

process.env.MICME_STREAM_DIAGNOSTICS = "0";
process.env.MICME_STREAM_FLUSH_MS = "20";
process.env.MICME_STREAM_WORDS_PER_CHUNK = "10";

const {
	buildWhisperStreamCommand,
	drainStreamingOutput,
	flushPendingStreamingWords,
	getStreamingTranscript,
	sanitizeStreamingText,
	clearStreamingFlush,
} = await import("../src/streaming.ts");

function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function createHarness(baseText = "") {
	let editorText = baseText;
	const updates = [];
	const notifications = [];
	const ctx = {
		ui: {
			setEditorText(text) {
				updates.push(text);
				editorText = text;
			},
			getEditorText() {
				return editorText;
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};
	const state = {
		baseText,
		previewText: baseText,
		outputBuffer: "",
		lastText: "",
		emittedWords: [],
		candidateWords: [],
		lastHypothesisWords: [],
		startedAt: Date.now(),
	};
	const active = { streaming: state, audioLevel: () => 0 };
	return { ctx, state, active, updates, notifications };
}

function feedFrame(harness, frame) {
	drainStreamingOutput(harness.ctx, harness.active, false, `${frame}\n`);
}

function finish(harness) {
	flushPendingStreamingWords(harness.ctx, harness.state);
	clearStreamingFlush(harness.state);
}

function runFrames(frames) {
	const harness = createHarness();
	for (const frame of frames) feedFrame(harness, frame);
	finish(harness);
	return harness;
}

function assertAppendOnly(updates) {
	for (let index = 1; index < updates.length; index++) {
		assert.ok(
			updates[index].startsWith(updates[index - 1]),
			`editor update ${index} should append only\nprevious: ${JSON.stringify(updates[index - 1])}\nnext:     ${JSON.stringify(updates[index])}`,
		);
	}
}

function assertTranscript(harness, expected) {
	assert.equal(getStreamingTranscript(harness.state), expected);
}

test("cumulative stream frames append without visible rewrite", () => {
	const harness = runFrames(["Cat", "Cat is", "Cat is white"]);

	assertTranscript(harness, "Cat is white");
	assert.deepEqual(harness.state.emittedWords, ["Cat", "is", "white"]);
	assert.deepEqual(harness.notifications, []);
	assertAppendOnly(harness.updates);
});

test("incremental stream frames preserve fast short phrases", () => {
	const harness = runFrames(["Cat", "is", "white"]);

	assertTranscript(harness, "Cat is white");
	assert.deepEqual(harness.updates, ["Cat", "Cat is", "Cat is white "]);
	assertAppendOnly(harness.updates);
});

test("streaming preview separates existing editor text from dictated words", () => {
	const harness = createHarness("Please");
	feedFrame(harness, "write");
	feedFrame(harness, "write tests");
	finish(harness);

	assertTranscript(harness, "write tests");
	assert.deepEqual(harness.updates, ["Please write", "Please write tests "]);
	assertAppendOnly(harness.updates);
});

test("rolling window frames do not duplicate overlap words", () => {
	const harness = runFrames(["Cat is", "is white"]);

	assertTranscript(harness, "Cat is white");
	assert.deepEqual(harness.state.emittedWords, ["Cat", "is", "white"]);
	assert.ok(!getStreamingTranscript(harness.state).includes("is is"));
	assertAppendOnly(harness.updates);
});

test("unstable corrections can change internally without editor churn", () => {
	const harness = runFrames(["Cat is", "That is", "Cat is white"]);

	assertTranscript(harness, "Cat is white");
	assert.ok(!harness.updates.some((text) => /\bThat\b/.test(text)), `did not expect visible correction: ${JSON.stringify(harness.updates)}`);
	assertAppendOnly(harness.updates);
});

test("streaming text sanitization strips terminal control sequences", () => {
	assert.equal(sanitizeStreamingText("\u001b]52;c;clipboard\u0007Cat \u001b[31mwhite"), "Cat white");
});

test("reset and noise frames do not delete committed text", () => {
	const harness = createHarness();
	feedFrame(harness, "Cat");
	feedFrame(harness, "Cat");
	assertTranscript(harness, "Cat");
	assert.deepEqual(harness.updates, ["Cat"]);

	feedFrame(harness, "[BLANK_AUDIO]");
	feedFrame(harness, "thank you");
	feedFrame(harness, "");
	finish(harness);

	assertTranscript(harness, "Cat");
	assert.deepEqual(harness.updates, ["Cat", "Cat "]);
	assertAppendOnly(harness.updates);
});

test("pause flush commits the last candidate after a quiet interval", async () => {
	const harness = createHarness();
	feedFrame(harness, "Cat");
	assert.deepEqual(harness.updates, []);

	await new Promise((resolve) => setTimeout(resolve, 40));

	assertTranscript(harness, "Cat");
	assert.deepEqual(harness.updates, ["Cat"]);
	assertAppendOnly(harness.updates);
	clearStreamingFlush(harness.state);
});

test("whisper-stream command enables translation with the selected source language", () => {
	withEnv({ MICME_TRANSLATE_TO_ENGLISH: "bs", MICME_LANGUAGE: "en" }, () => {
		const command = buildWhisperStreamCommand("/bin/whisper-stream", "/models/ggml-small.bin", "/tmp");
		assert.ok(command.args.includes("-tr"));
		assert.deepEqual(command.args.slice(command.args.indexOf("-l"), command.args.indexOf("-l") + 2), ["-l", "bs"]);
	});
});

test("stream diagnostics are opt-in and include frame state", () => {
	process.env.MICME_STREAM_DIAGNOSTICS = "1";
	try {
		const harness = createHarness();
		feedFrame(harness, "Cat");
		clearStreamingFlush(harness.state);

		const frameNotification = harness.notifications.find((entry) => entry.message.startsWith("Micme stream frame: "));
		assert.ok(frameNotification, `expected frame diagnostics, got ${JSON.stringify(harness.notifications)}`);
		const payload = JSON.parse(frameNotification.message.replace(/^Micme stream frame: /, ""));
		assert.equal(payload.sanitizedText, "Cat");
		assert.equal(payload.extractionMode, "cumulative");
		assert.deepEqual(payload.candidateWords, ["Cat"]);
	} finally {
		process.env.MICME_STREAM_DIAGNOSTICS = "0";
	}
});
