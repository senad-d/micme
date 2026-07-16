import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const { reloadMicmeConfig } = await import("../src/config.ts");
const { MAX_CAPTURED_OUTPUT_CHARS } = await import("../src/constants.ts");
const {
	discoverAudioDevices,
	listAudioDevices,
	parseAvfoundationAudioDevices,
	prepareAudioForTranscription,
	registerDeviceMessageRenderer,
	validateRecordedAudio,
} = await import("../src/audio.ts");

async function withEnv(values, fn) {
	const previous = new Map();
	for (const key of Object.keys(values)) {
		previous.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	reloadMicmeConfig();
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		reloadMicmeConfig();
	}
}

async function withPlatform(platform, fn) {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return await fn();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

async function writeExecutable(path, content) {
	await writeFile(path, content);
	await chmod(path, 0o755);
}

function createWidgetCtx() {
	const widgets = [];
	return {
		widgets,
		ctx: {
			ui: {
				setWidget(key, lines) {
					widgets.push({ key, lines });
				},
			},
		},
	};
}

test("audio device listing handles unsupported platforms and missing ffmpeg", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-audio-devices-empty-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const unsupported = createWidgetCtx();
	await withPlatform("sunos", async () => {
		await listAudioDevices(unsupported.ctx);
	});
	assert.match(unsupported.widgets.at(-1)?.lines.join("\n") ?? "", /not implemented for this platform/);

	const missing = createWidgetCtx();
	await withPlatform("linux", async () => {
		await withEnv({ PATH: join(root, "missing-bin") }, async () => {
			await listAudioDevices(missing.ctx);
		});
	});
	assert.match(missing.widgets.at(-1)?.lines.join("\n") ?? "", /ffmpeg not found/);
});

test("audio device listing parses PulseAudio output", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-audio-pulse-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeExecutable(
		join(bin, "ffmpeg"),
		[
			"#!/bin/sh",
			"echo 'Auto-detected sources for pulse'",
			"echo '* default [default]'",
			"echo 'alsa_input.usb [Microsoft Teams Audio]'",
			"echo 'warning after scan' >&2",
		].join("\n"),
	);

	const harness = createWidgetCtx();
	await withPlatform("linux", async () => {
		await withEnv({ PATH: bin, LANG: "C.UTF-8" }, async () => {
			await listAudioDevices(harness.ctx);
			assert.deepEqual(await discoverAudioDevices(), [{ label: "default", value: "default", description: "PulseAudio default source" }]);
		});
	});
	const panel = harness.widgets.at(-1)?.lines.join("\n") ?? "";
	assert.match(panel, /Pulse/);
	assert.match(panel, /PulseAudio default source|default/);
	assert.match(panel, /Teams Audio/);
	assert.match(panel, /warning/);
});

test("registered device renderer receives DirectShow panels", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-audio-dshow-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeExecutable(
		join(bin, "ffmpeg.EXE"),
		[
			"#!/bin/sh",
			"echo 'DirectShow video devices' >&2",
			"echo '\"Integrated Camera\"' >&2",
			"echo 'DirectShow audio devices' >&2",
			"echo '\"Studio Mic\"' >&2",
			"echo 'Immediate exit requested' >&2",
			"exit 1",
		].join("\n"),
	);
	let renderer;
	const sent = [];
	const pi = {
		registerMessageRenderer(type, nextRenderer) {
			renderer = { type, nextRenderer };
		},
		sendMessage(message) {
			sent.push(message);
		},
	};

	registerDeviceMessageRenderer(pi);
	await withPlatform("win32", async () => {
		await withEnv({ PATH: bin, PATHEXT: ".EXE", LANG: "C.UTF-8" }, async () => {
			await listAudioDevices(createWidgetCtx().ctx, pi);
		});
	});

	assert.equal(renderer?.type, "micme-devices");
	assert.equal(sent[0]?.customType, "micme-devices");
	const component = renderer.nextRenderer(sent[0], {}, {});
	assert.match(component.render(60).join("\n"), /Studio Mic/);
	component.invalidate();
	const fallback = renderer.nextRenderer({ customType: "micme-devices", content: "bad", display: true, details: { backend: "bad" } }, {}, {});
	assert.match(fallback.render(50).join("\n"), /Could not render Micme devices panel/);
});

test("macOS device listing detects microphone permission errors and AVF candidates", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-audio-avf-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeExecutable(
		join(bin, "ffmpeg"),
		[
			"#!/bin/sh",
			"echo 'AVFoundation audio devices:' >&2",
			"echo '[0] Studio Mic' >&2",
			"echo 'not authorized to capture microphone' >&2",
			"exit 1",
		].join("\n"),
	);
	const harness = createWidgetCtx();

	await withPlatform("darwin", async () => {
		await withEnv({ PATH: bin }, async () => {
			await listAudioDevices(harness.ctx);
			assert.deepEqual(await discoverAudioDevices(), [{ label: "0: Studio Mic", value: "0", description: "Studio Mic" }]);
		});
	});

	assert.match(harness.widgets.at(-1)?.lines.join("\n") ?? "", /AVFoundation|Studio Mic/);
	assert.deepEqual(parseAvfoundationAudioDevices("AVFoundation audio devices:\n[2] USB Mic"), [{ label: "2: USB Mic", value: "2", description: "USB Mic" }]);
});

test("audio preprocessing and validation use ffmpeg output and skip flags", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-audio-process-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const work = join(root, "work");
	await mkdir(bin);
	await mkdir(work);
	const input = join(work, "raw.wav");
	await writeFile(input, "raw");
	await writeExecutable(
		join(bin, "ffmpeg"),
		[
			"#!/bin/sh",
			"case \" $* \" in",
			"  *\" volumedetect \"*) echo 'mean_volume: -24.5 dB' >&2; echo 'max_volume: -12.0 dB' >&2; exit 0 ;;",
			"esac",
			"last=''",
			"for arg in \"$@\"; do last=\"$arg\"; done",
			"printf clip > \"$last\"",
		].join("\n"),
	);

	await withEnv({ PATH: bin, MICME_TRANSCRIBE_SAMPLE_RATE: "8000", MICME_AUDIO_FILTER: "", MICME_MIN_MAX_VOLUME_DB: "-50" }, async () => {
		const output = await prepareAudioForTranscription(input, work);
		assert.equal(output, join(work, "clip.wav"));
		assert.equal(await readFile(output, "utf8"), "clip");
		const validation = await validateRecordedAudio(input);
		assert.equal(validation.status, "validated");
		assert.equal(validation.diagnostics.meanVolumeDb, -24.5);
		assert.equal(validation.diagnostics.maxVolumeDb, -12);
	});

	await withEnv({ MICME_PROCESS_AUDIO: "0", MICME_VALIDATE_AUDIO: "0" }, async () => {
		assert.equal(await prepareAudioForTranscription(input, work), input);
		assert.deepEqual(await validateRecordedAudio(input), { status: "skipped", reason: "disabled" });
	});

	await withEnv({ PATH: join(root, "missing-bin"), MICME_VALIDATE_AUDIO: "1", MICME_SKIP_AUDIO_VALIDATION: "0" }, async () => {
		assert.deepEqual(await validateRecordedAudio(input), { status: "skipped", reason: "ffmpeg-unavailable" });
	});
});

test("audio preprocessing and validation surface ffmpeg failures", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX shell shims are not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-audio-failure-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const work = join(root, "work");
	await mkdir(bin);
	await mkdir(work);
	const input = join(work, "raw.wav");
	await writeFile(input, "raw");

	await writeExecutable(join(bin, "ffmpeg"), "#!/bin/sh\necho 'bad filter' >&2\nexit 2\n");
	await withEnv({ PATH: bin }, async () => {
		await assert.rejects(prepareAudioForTranscription(input, work), /audio preprocessing failed/);
		await assert.rejects(validateRecordedAudio(input), /could not inspect recorded audio/);
	});

	await writeExecutable(
		join(bin, "ffmpeg"),
		"#!/bin/sh\necho 'mean_volume: -90 dB' >&2\necho 'max_volume: -80 dB' >&2\nexit 0\n",
	);
	await withEnv({ PATH: bin, MICME_MIN_MAX_VOLUME_DB: "-50" }, async () => {
		await assert.rejects(validateRecordedAudio(input), /almost-silent audio/);
	});

	await writeExecutable(
		join(bin, "ffmpeg"),
		"#!/bin/sh\necho 'mean_volume: -inf dB' >&2\necho 'max_volume: -inf dB' >&2\nexit 0\n",
	);
	await withEnv({ PATH: bin, MICME_MIN_MAX_VOLUME_DB: "-50" }, async () => {
		await assert.rejects(validateRecordedAudio(input), /almost-silent audio \(max -inf dB/);
	});
});

test("audio validation rejects missing, malformed, partial, and truncated metrics", async (t) => {
	if (process.platform === "win32") {
		t.skip("Executable fixture is not portable to Windows");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "micme-audio-validation-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const input = join(root, "raw.wav");
	await mkdir(bin);
	await writeFile(input, "raw");
	await writeExecutable(
		join(bin, "ffmpeg"),
		`#!/usr/bin/env node
const mode = process.env.MICME_TEST_VALIDATION_CASE;
if (mode === "malformed") process.stderr.write("\\u001b[31mmax_volume: loud dB\\u001b[0m\\n");
if (mode === "partial") process.stderr.write("mean_volume: -20 dB\\nmax_vol");
if (mode === "oversized") {
  process.stderr.write("x".repeat(${MAX_CAPTURED_OUTPUT_CHARS + 1}) + "\\nmax_volume: -12 dB\\n", () => process.exit(0));
} else {
  process.exit(0);
}
`,
	);

	const cases = [
		{ mode: "empty", pattern: /produced no diagnostic output/ },
		{ mode: "malformed", pattern: /required max_volume metric/ },
		{ mode: "partial", pattern: /required max_volume metric/ },
		{ mode: "oversized", pattern: /capture limit/ },
	];
	for (const validationCase of cases) {
		await withEnv(
			{
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				MICME_VALIDATE_AUDIO: "1",
				MICME_SKIP_AUDIO_VALIDATION: "0",
				MICME_TEST_VALIDATION_CASE: validationCase.mode,
			},
			async () => {
				await assert.rejects(validateRecordedAudio(input), (error) => {
					assert.match(error.message, validationCase.pattern);
					assert.equal(error.message.includes("\u001b"), false);
					assert.ok(error.message.length <= MAX_CAPTURED_OUTPUT_CHARS + 500);
					return true;
				});
			},
		);
	}
});
