import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as capture from "../src/live-capture.ts";
import { findExecutable, hasRecorderExited, spawnRecording, stopProcess } from "../src/processes.ts";
import { createLiveRecordingDirectory } from "../src/recording-dir.ts";

const { buildFfmpegRecorderArgs, buildRecorderCommand, parseAvfoundationDevices, parseDirectShowDevices, parseVolumeDb, renderDevicePanel } = await import("../src/audio.ts");
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

test("DirectShow device parsing handles whole-line and fallback quoted names", () => {
	const parsed = parseDirectShowDevices([
		"DirectShow video devices",
		'"Integrated Camera"',
		"DirectShow audio devices",
		'    Some prefix "Studio  Mic" extra text',
		'Alternative name "@device_pnp_ignored"',
	].join("\n"));

	assert.deepEqual(parsed.video, [{ name: "Integrated Camera", captureName: "Integrated Camera" }]);
	assert.deepEqual(parsed.audio, [{ name: "Studio Mic", captureName: "Studio  Mic" }]);
});

test("DirectShow device parsing handles ffmpeg >=7 headerless listing with (audio)/(video) suffixes", () => {
	const parsed = parseDirectShowDevices([
		'[in#0 @ 0x1] Could not enumerate video devices (or none found).',
		'[in#0 @ 0x1] "Remote Audio" (audio)',
		'[in#0 @ 0x1]   Alternative name "@device_cm_{GUID}\\wave_{GUID}"',
		'Error opening input file dummy.',
	].join("\n"));

	assert.deepEqual(parsed.audio, [{ name: "Remote Audio", captureName: "Remote Audio" }]);
	assert.deepEqual(parsed.video, []);
	assert.equal(parsed.sawDeviceSection, false);
});

test("DirectShow device parsing keys kind off the (audio)/(video) suffix even with section headers", () => {
	const parsed = parseDirectShowDevices([
		"DirectShow audio devices",
		'"Microphone (Realtek Audio)" (audio)',
		'"Integrated Camera" (video)',
	].join("\n"));

	assert.deepEqual(parsed.audio, [{ name: "Microphone (Realtek Audio)", captureName: "Microphone (Realtek Audio)" }]);
	assert.deepEqual(parsed.video, [{ name: "Integrated Camera", captureName: "Integrated Camera" }]);
});

test("volume parsing handles finite and negative-infinite ffmpeg volumes", () => {
	const output = "[Parsed_volumedetect_0 @ 0x1234] mean_volume: -inf dB\r\n[Parsed_volumedetect_0 @ 0x1234] max_volume: -12.4 dB";

	assert.equal(parseVolumeDb(output, "mean_volume"), Number.NEGATIVE_INFINITY);
	assert.equal(parseVolumeDb(output, "max_volume"), -12.4);
	assert.equal(parseVolumeDb("[Parsed_volumedetect_1 @ 0000ABCD] mean_volume: 0 dB", "mean_volume"), 0);
	assert.equal(parseVolumeDb("[Parsed_volumedetect_0 @ 0x1234] max_volume: inf dB", "max_volume"), undefined);
});

test("volume parsing uses the filter metric instead of volume text in filenames or other logs", () => {
	const output = [
		"Input #0, wav, from '/tmp/max_volume: -80 dB/tone.wav':",
		"max_volume: -80 dB",
		"[wav @ 0x1234] max_volume: -80 dB",
		"[Parsed_volumedetect_0 @ 0x5678] max_volume: -18.1 dB",
	].join("\n");

	assert.equal(parseVolumeDb(output, "max_volume"), -18.1);
});

test("volume parsing requires a complete metric on one line", () => {
	const output = [
		"[Parsed_volumedetect_0 @ 0x1234] max_volume: -80 dB (extra text)",
		"[Parsed_volumedetect_0 @ 0x1234] max_volume:",
		" -80 dB",
	].join("\n");

	assert.equal(parseVolumeDb(output, "max_volume"), undefined);
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

test("plain device panel renders source separators as ASCII", () => {
	withEnv({ MICME_PLAIN: "1" }, () => {
		const panel = renderDevicePanel(
			{
				sourceLabel: "macOS · AVF",
				backend: "avfoundation",
				audio: [],
			},
			80,
		);

		assert.match(panel, /macOS - AVF/);
		assert.equal(panel.includes("·"), false);
	});
});

test("custom record commands receive the shared Micme placeholders", async () => {
	const command = await withEnv({ MICME_RECORD_COMMAND: "rec {audio} {tempDir} {transcript}" }, () => buildRecorderCommand("/tmp/micme-record/raw.wav"));
	assert.equal(command.display.includes("{tempDir}"), false);
	assert.equal(command.display.includes("{transcript}"), false);
	assert.match(command.display, /raw\.wav/);
	assert.match(command.display, /transcript\.txt/);
});

async function liveSpool(t) {
	const directory = await createLiveRecordingDirectory(".", false);
	t.after(async () => {
		try {
			await directory.remove();
		} finally {
			directory.close();
		}
	});
	return { directory, path: join(directory.filesPath, "raw.wav") };
}

const LIVE_SETTINGS = {
	MICME_RECORD_COMMAND: undefined,
	MICME_RECORD_METER: "1",
	MICME_RECORD_SAMPLE_RATE: "48000",
	MICME_RECORD_SYNC: "0",
	MICME_AUDIO_FILTER: "volume=0.5",
	MICME_PULSE_SOURCE: "test-input",
	MICME_AVFOUNDATION_INPUT: ":3",
	MICME_DSHOW_AUDIO_DEVICE: "Studio  Mic",
};
const ffmpeg = findExecutable(["ffmpeg"]);
const ffmpegOnly = { skip: !ffmpeg && "FFmpeg is not installed" };

test("live recorder shares the clip device and writes one worker-format output with at most one configured filter", ffmpegOnly, async (t) => {
	const { directory, path } = await liveSpool(t);
	for (const enabled of ["1", "0"]) {
		const { args } = await withEnv({ ...LIVE_SETTINGS, MICME_PROCESS_AUDIO: enabled }, () => capture.buildLiveRecorderCommand(path, directory, t.signal));
		const clip = await withEnv(LIVE_SETTINGS, () => buildRecorderCommand(path));
		assert.equal(args[args.indexOf("-i") + 1], clip.args[clip.args.indexOf("-i") + 1]);
		assert.equal(args.filter((arg) => arg === "-i").length, 1);
		assert.equal(args.filter((arg) => arg === "-map").length, 1);
		assert.equal(args.includes("pipe:1"), false);
		assert.equal(args[args.indexOf("-ar") + 1], "16000");
		assert.equal(args[args.indexOf("-ac") + 1], "1");
		assert.equal(args[args.indexOf("-c:a") + 1], "pcm_s16le");
		assert.equal(args[args.indexOf("-flush_packets") + 1], "1");
		assert.equal(args.join(" ").split("volume=0.5").length - 1, Number(enabled));
		assert.equal(args.at(-1), path);
	}
});

test("live custom hooks preserve the clip template and own all their filtering", async (t) => {
	const { directory, path } = await liveSpool(t);
	const live = await withEnv({ MICME_PROCESS_AUDIO: "1", MICME_AUDIO_FILTER: "volume=0.5", MICME_RECORD_COMMAND: "rec {audio} {tempDir} {transcript}" }, () => capture.buildLiveRecorderCommand(path, directory, t.signal));
	const clip = await withEnv({ MICME_RECORD_COMMAND: "rec {audio} {tempDir} {transcript}" }, () => buildRecorderCommand(path, directory.filesPath));
	assert.deepEqual(live, clip);
});

test("the FFmpeg live output exposes real-time samples before recorder close and drains its final tail", { ...ffmpegOnly, timeout: 10_000 }, async (t) => {
	const { directory, path } = await liveSpool(t);
	const spec = await withEnv({ ...LIVE_SETTINGS, MICME_RECORD_SYNC: "1", MICME_PROCESS_AUDIO: "1" }, () => capture.buildLiveRecorderCommand(path, directory, t.signal));
	const args = ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=16000", "-t", "5", ...spec.args.slice(spec.args.indexOf("-i") + 2)];
	const started = performance.now();
	const recording = spawnRecording({ ...spec, args }, path, directory.filesPath, directory);
	const signal = AbortSignal.any([t.signal, AbortSignal.timeout(7_000)]);
	try {
		const reader = await capture.openLivePcm(path, directory, signal);
		try {
			let first;
			while (!hasRecorderExited(recording)) {
				({ pcm: first } = await reader.read(false));
				if (first.length) break;
				await delay(20, undefined, { signal });
			}
			assert.equal(hasRecorderExited(recording), false, "live samples must be available while the recorder is running");
			assert.ok(first?.length > 0 && performance.now() - started < 3_000, "PCM packets must be readable promptly, not buffered until near stop");
			let consumed = first.length / 2;
			let peak = 0;
			for (let offset = 0; offset < first.length; offset += 2) peak = Math.max(peak, Math.abs(first.readInt16LE(offset)));
			assert.ok(peak >= 2000 && peak <= 2100, `one volume=0.5 pass should halve the FFmpeg sine source peak; got ${peak}`);
			const exit = await stopProcess(recording);
			assert.equal(exit.code, 0, recording.stderr());
			for (;;) {
				const { pcm, availableThrough } = await reader.read(true);
				consumed += pcm.length / 2;
				if (pcm.length === 0) {
					assert.equal(availableThrough, consumed);
					break;
				}
			}
		} finally {
			reader.close();
		}
	} finally {
		await stopProcess(recording);
	}
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
