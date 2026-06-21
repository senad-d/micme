import assert from "node:assert/strict";
import test from "node:test";

const { buildFfmpegRecorderArgs, buildRecorderCommand, parseAvfoundationDevices, renderDevicePanel } = await import("../src/audio.ts");
const { getAvfoundationDropLateFrames, getAvfoundationInputSampleRate, getRecordMeter, getRecordSampleRate, getRecordSync, reloadMicmeConfig } = await import("../src/config.ts");

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

test("file-only recorder args avoid the stdout meter branch", () => {
	const args = buildFfmpegRecorderArgs("pulse", "default", "/tmp/micme-audio-test/raw.wav", "48000", { meter: false });

	assert.equal(args.includes("-filter_complex"), false);
	assert.equal(args.includes("pipe:1"), false);
	assert.equal(args[args.indexOf("-map") + 1], "0:a:0");
	assert.equal(args.at(-1), "/tmp/micme-audio-test/raw.wav");
});

test("auto record sample rate leaves ffmpeg on the input native rate", () => {
	const args = buildFfmpegRecorderArgs("pulse", "default", "/tmp/micme-audio-test/raw.wav", undefined, { meter: false });

	assert.equal(args.includes("-ar"), false);
	assert.equal(args[args.indexOf("-map") + 1], "0:a:0");
});

test("metered recorder args keep the legacy stdout PCM branch", () => {
	const args = buildFfmpegRecorderArgs("pulse", "default", "/tmp/micme-audio-test/raw.wav", "48000", { meter: true });

	assert.equal(args.includes("-filter_complex"), true);
	assert.equal(args.includes("[0:a]asplit=2[micme_file][micme_meter]"), true);
	assert.equal(args.at(-1), "pipe:1");
});

test("macOS AVFoundation input options are placed before the input", () => {
	const args = buildFfmpegRecorderArgs("avfoundation", ":2", "/tmp/micme-audio-test/raw.wav", "48000", {
		meter: false,
		inputOptions: ["-drop_late_frames", "false"],
	});

	assert.ok(args.indexOf("-drop_late_frames") > args.indexOf("avfoundation"));
	assert.ok(args.indexOf("-drop_late_frames") < args.indexOf("-i"));
	assert.equal(args[args.indexOf("-drop_late_frames") + 1], "false");
});

test("timing sync filter is applied before output resampling", () => {
	const args = buildFfmpegRecorderArgs("pulse", "default", "/tmp/micme-audio-test/raw.wav", "48000", {
		meter: false,
		audioFilters: ["aresample=async=1:first_pts=0"],
	});

	assert.equal(args.includes("-filter_complex"), true);
	assert.equal(args[args.indexOf("-filter_complex") + 1], "[0:a]aresample=async=1:first_pts=0[micme_file]");
	assert.equal(args[args.indexOf("-map") + 1], "[micme_file]");
});

test("AVFoundation sample-rate fallback is applied before output resampling", () => {
	const args = buildFfmpegRecorderArgs("avfoundation", ":2", "/tmp/micme-audio-test/raw.wav", "96000", {
		meter: false,
		audioFilters: ["asetrate=44100"],
	});

	assert.equal(args.includes("-filter_complex"), true);
	assert.equal(args[args.indexOf("-filter_complex") + 1], "[0:a]asetrate=44100[micme_file]");
	assert.equal(args[args.indexOf("-map") + 1], "[micme_file]");
	assert.equal(args[args.indexOf("-ar") + 1], "96000");
});

test("AVFoundation sample-rate fallback feeds both file and meter branches", () => {
	const args = buildFfmpegRecorderArgs("avfoundation", ":2", "/tmp/micme-audio-test/raw.wav", "48000", {
		meter: true,
		audioFilters: ["asetrate=44100"],
	});

	assert.equal(args[args.indexOf("-filter_complex") + 1], "[0:a]asetrate=44100,asplit=2[micme_file][micme_meter]");
	assert.equal(args.at(-1), "pipe:1");
});

test("device parsing strips terminal control sequences from names", () => {
	const parsed = parseAvfoundationDevices("AVFoundation audio devices:\n[0] \u001b]52;c;clipboard\u0007Studio \u001b[31mMic");

	assert.deepEqual(parsed.audio, [{ id: "0", name: "Studio Mic" }]);
});

test("device panel rendering strips terminal control sequences from persisted details", () => {
	const panel = renderDevicePanel(
		{
			sourceLabel: "macOS\u001b]52;c;clipboard\u0007",
			backend: "avfoundation",
			audio: [{ id: "0", name: "\u001b[31mStudio Mic\u001b[0m" }],
			warning: "\u001bPignored\u001b\\warning",
		},
		80,
	);

	assert.equal(panel.includes("\u001b"), false);
	assert.match(panel, /Studio Mic/);
	assert.match(panel, /warning/);
});

test("custom record commands receive the shared Micme placeholders", () => {
	withEnv({ MICME_RECORD_COMMAND: "rec {audio} {tempDir} {transcript}" }, () => {
		const command = buildRecorderCommand("/tmp/micme-record/raw.wav");
		assert.equal(command.display.includes("{tempDir}"), false);
		assert.equal(command.display.includes("{transcript}"), false);
		assert.match(command.display, /raw\.wav/);
		assert.match(command.display, /transcript\.txt/);
	});
});

test("recording quality flags use safe defaults and explicit overrides", () => {
	withEnv({ PI_CODING_AGENT_DIR: "/tmp/micme-test-empty-agent", MICME_RECORD_SAMPLE_RATE: undefined, MICME_RECORD_SYNC: undefined, MICME_RECORD_METER: undefined, MICME_AVFOUNDATION_DROP_LATE_FRAMES: undefined, MICME_AVFOUNDATION_INPUT_SAMPLE_RATE: undefined }, () => {
		assert.equal(getRecordSampleRate(), undefined);
		assert.equal(getRecordSync(), true);
		assert.equal(getRecordMeter(), false);
		assert.equal(getAvfoundationDropLateFrames(), false);
		assert.equal(getAvfoundationInputSampleRate(), undefined);
	});

	withEnv({ MICME_RECORD_SAMPLE_RATE: "48000", MICME_RECORD_SYNC: "0", MICME_RECORD_METER: "1", MICME_AVFOUNDATION_DROP_LATE_FRAMES: "1", MICME_AVFOUNDATION_INPUT_SAMPLE_RATE: "44100" }, () => {
		assert.equal(getRecordSampleRate(), 48000);
		assert.equal(getRecordSync(), false);
		assert.equal(getRecordMeter(), true);
		assert.equal(getAvfoundationDropLateFrames(), true);
		assert.equal(getAvfoundationInputSampleRate(), 44100);
	});
});
