import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { AUDIO_VALIDATION_TIMEOUT_MS } from "./constants.ts";
import { env, envFlag, getAudioFilter, getMinMaxVolumeDb, getRecordSampleRate, getTranscribeSampleRate } from "./config.ts";
import { findExecutable, formatRunExit, replacePlaceholders, runProcess, shellCommand, shellQuote } from "./processes.ts";
import type { AudioDeviceCandidate, AudioDiagnostics, CommandSpec, RunResult } from "./types.ts";

export async function listAudioDevices(ctx: ExtensionContext) {
	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) {
		ctx.ui.notify("ffmpeg is not installed, so Micme cannot list audio devices.", "warning");
		return;
	}

	let title = "Micme audio devices";
	let result: RunResult;
	if (process.platform === "darwin") {
		result = await runProcess(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], 8_000);
		title = "Micme macOS avfoundation devices";
	} else if (process.platform === "linux") {
		result = await runProcess(ffmpeg, ["-hide_banner", "-sources", "pulse"], 8_000);
		title = "Micme Linux PulseAudio sources";
	} else if (process.platform === "win32") {
		result = await runProcess(ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 8_000);
		title = "Micme Windows DirectShow devices";
	} else {
		ctx.ui.notify(`Device listing is not implemented for ${process.platform}.`, "warning");
		return;
	}

	const output = `${result.stdout}\n${result.stderr}`.trim() || "No device output.";
	await ctx.ui.editor(title, output);
}

export async function discoverAudioDevices(): Promise<AudioDeviceCandidate[]> {
	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) return [];

	if (process.platform === "darwin") {
		const result = await runProcess(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], 8_000);
		return parseAvfoundationAudioDevices(`${result.stdout}\n${result.stderr}`);
	}

	if (process.platform === "linux") {
		return [{ label: "default", value: "default", description: "PulseAudio default source" }];
	}

	if (process.platform === "win32") {
		return [{ label: "default", value: "default", description: "DirectShow default audio input" }];
	}

	return [];
}

export function parseAvfoundationAudioDevices(output: string): AudioDeviceCandidate[] {
	const devices: AudioDeviceCandidate[] = [];
	let inAudioDevices = false;
	for (const line of output.split(/\r?\n/)) {
		if (line.includes("AVFoundation audio devices:")) {
			inAudioDevices = true;
			continue;
		}
		if (inAudioDevices && line.includes("Error opening input")) break;
		if (!inAudioDevices) continue;
		const match = line.match(/\[(\d+)\]\s+(.+)$/);
		if (!match) continue;
		const value = match[1] ?? "";
		const name = (match[2] ?? "").trim();
		devices.push({ label: `${value}: ${name}`, value, description: name });
	}
	return devices;
}

export async function prepareAudioForTranscription(inputPath: string, tempDir: string) {
	if (env("MICME_PROCESS_AUDIO") === "0") return inputPath;

	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) return inputPath;

	const outputPath = join(tempDir, "clip.wav");
	const filter = getAudioFilter();
	const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath];
	if (filter) args.push("-af", filter);
	args.push("-ac", "1", "-ar", String(getTranscribeSampleRate()), "-c:a", "pcm_s16le", outputPath);

	const result = await runProcess(ffmpeg, args, AUDIO_VALIDATION_TIMEOUT_MS);
	if (result.code !== 0) {
		throw new Error(`Micme audio preprocessing failed (${formatRunExit(result)}):\n${result.stderr || result.stdout}`);
	}

	return outputPath;
}

export async function validateRecordedAudio(audioPath: string): Promise<AudioDiagnostics | undefined> {
	if (env("MICME_VALIDATE_AUDIO") === "0" || envFlag("MICME_SKIP_AUDIO_VALIDATION")) return undefined;

	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) return undefined;

	const result = await runProcess(ffmpeg, ["-hide_banner", "-nostats", "-i", audioPath, "-af", "volumedetect", "-f", "null", "-"], AUDIO_VALIDATION_TIMEOUT_MS);
	const raw = `${result.stdout}\n${result.stderr}`.trim();
	if (result.code !== 0) {
		throw new Error(`Micme could not inspect recorded audio (${formatRunExit(result)}):\n${raw}`);
	}

	const diagnostics: AudioDiagnostics = {
		meanVolumeDb: parseVolumeDb(raw, "mean_volume"),
		maxVolumeDb: parseVolumeDb(raw, "max_volume"),
		raw,
	};

	const minimumMaxVolumeDb = getMinMaxVolumeDb();
	if (diagnostics.maxVolumeDb !== undefined && diagnostics.maxVolumeDb < minimumMaxVolumeDb) {
		throw new Error(
			`Micme recorded almost-silent audio (max ${diagnostics.maxVolumeDb.toFixed(1)} dB; threshold ${minimumMaxVolumeDb.toFixed(1)} dB). ` +
				"Whisper often hallucinates phrases like 'Thank you very much' from silence. " +
				"Run /micme devices and set MICME_AUDIO_DEVICE to the real microphone, or set MICME_VALIDATE_AUDIO=0 to bypass this check.",
		);
	}

	return diagnostics;
}

export function parseVolumeDb(output: string, label: "mean_volume" | "max_volume") {
	const match = output.match(new RegExp(`${label}:\\s*(-?(?:\\d+(?:\\.\\d+)?|inf))\\s*dB`, "i"));
	if (!match) return undefined;
	return match[1]?.toLowerCase() === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

export function buildRecorderCommand(audioPath: string): CommandSpec {
	const custom = env("MICME_RECORD_COMMAND");
	if (custom?.trim()) {
		const expanded = replacePlaceholders(custom, { audio: audioPath });
		return shellCommand(expanded);
	}

	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) {
		throw new Error("Micme needs ffmpeg for recording, or set MICME_RECORD_COMMAND.");
	}

	const recordSampleRate = String(getRecordSampleRate());

	if (process.platform === "darwin") {
		const input = env("MICME_AVFOUNDATION_INPUT") || `:${env("MICME_AUDIO_DEVICE") || "0"}`;
		const args = buildMeteredFfmpegRecorderArgs("avfoundation", input, audioPath, recordSampleRate);
		return { command: ffmpeg, args, display: `${ffmpeg} ${args.map(shellQuote).join(" ")}`, meterFromStdout: true, stopInput: "q\n" };
	}

	if (process.platform === "linux") {
		const input = env("MICME_PULSE_SOURCE") || "default";
		const args = buildMeteredFfmpegRecorderArgs("pulse", input, audioPath, recordSampleRate);
		return { command: ffmpeg, args, display: `${ffmpeg} ${args.map(shellQuote).join(" ")}`, meterFromStdout: true, stopInput: "q\n" };
	}

	if (process.platform === "win32") {
		const input = `audio=${env("MICME_DSHOW_AUDIO_DEVICE") || "default"}`;
		const args = buildMeteredFfmpegRecorderArgs("dshow", input, audioPath, recordSampleRate);
		return { command: ffmpeg, args, display: `${ffmpeg} ${args.map(shellQuote).join(" ")}`, meterFromStdout: true, stopInput: "q\n" };
	}

	throw new Error(`Micme has no default recorder for ${process.platform}. Set MICME_RECORD_COMMAND.`);
}

export function buildMeteredFfmpegRecorderArgs(inputFormat: string, input: string, audioPath: string, recordSampleRate: string) {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-thread_queue_size",
		"4096",
		"-f",
		inputFormat,
		"-i",
		input,
		"-filter_complex",
		"[0:a]asplit=2[micme_file][micme_meter]",
		"-map",
		"[micme_file]",
		"-ac",
		"1",
		"-ar",
		recordSampleRate,
		"-c:a",
		"pcm_s16le",
		"-vn",
		"-y",
		audioPath,
		"-map",
		"[micme_meter]",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-f",
		"s16le",
		"pipe:1",
	];
}
