import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { env, expandConfigPath, getTranscribeTimeoutMs } from "./config.ts";
import { ensureWhisperCppModel, getDefaultWhisperCppModelPath } from "./models.ts";
import { findExecutable, formatRunExit, replacePlaceholders, runProcess, runShell } from "./processes.ts";

export async function transcribe(audioPath: string, tempDir: string, ctx?: ExtensionContext): Promise<string> {
	const custom = env("MICME_TRANSCRIBE_COMMAND");
	if (custom?.trim()) {
		return transcribeWithCustomCommand(custom, audioPath, tempDir);
	}

	const whisperCppBinary = getWhisperCppBinary();
	const whisperCppModel = env("MICME_WHISPER_CPP_MODEL") || (whisperCppBinary ? getDefaultWhisperCppModelPath() : undefined);
	if (whisperCppModel && whisperCppBinary) {
		return transcribeWithWhisperCpp(whisperCppBinary, expandConfigPath(whisperCppModel), audioPath, tempDir, ctx);
	}

	const openAiWhisper = findExecutable(["whisper"]);
	if (openAiWhisper) {
		return transcribeWithOpenAiWhisper(openAiWhisper, audioPath, tempDir);
	}

	throw new Error(
		"No Micme transcription backend found. Install whisper-cpp and set MICME_WHISPER_CPP_MODEL, " +
			"install openai-whisper, or set MICME_TRANSCRIBE_COMMAND.",
	);
}

export async function transcribeWithCustomCommand(template: string, audioPath: string, tempDir: string) {
	const transcriptPath = join(tempDir, "transcript.txt");
	const command = replacePlaceholders(template, { audio: audioPath, tempDir, transcript: transcriptPath });
	const result = await runShell(command, getTranscribeTimeoutMs());
	if (result.code !== 0) {
		throw new Error(`MICME_TRANSCRIBE_COMMAND failed (${formatRunExit(result)}):\n${result.stderr || result.stdout}`);
	}

	if (existsSync(transcriptPath)) {
		const fromFile = await readFile(transcriptPath, "utf8");
		if (fromFile.trim()) return fromFile;
	}

	return result.stdout;
}

export async function transcribeWithWhisperCpp(binary: string, modelPath: string, audioPath: string, tempDir: string, ctx?: ExtensionContext) {
	await ensureWhisperCppModel(modelPath, ctx);
	const outputBase = join(tempDir, "whisper-cpp");
	const args = ["-m", modelPath, "-f", audioPath, "-otxt", "-of", outputBase, "-nt", "-np", "-nf", "-sns"];
	const language = env("MICME_LANGUAGE");
	if (language?.trim()) args.push("-l", language.trim());

	const result = await runProcess(binary, args, getTranscribeTimeoutMs());
	if (result.code !== 0) {
		throw new Error(`whisper.cpp failed (${formatRunExit(result)}):\n${result.stderr || result.stdout}`);
	}

	const outputPath = `${outputBase}.txt`;
	if (existsSync(outputPath)) {
		const fromFile = await readFile(outputPath, "utf8");
		if (fromFile.trim()) return fromFile;
	}

	return result.stdout;
}

export async function transcribeWithOpenAiWhisper(binary: string, audioPath: string, tempDir: string) {
	const model = env("MICME_WHISPER_MODEL") || "base.en";
	const args = [
		audioPath,
		"--model",
		model,
		"--output_format",
		"txt",
		"--output_dir",
		tempDir,
		"--verbose",
		"False",
		"--condition_on_previous_text",
		"False",
	];

	const language = env("MICME_LANGUAGE");
	if (language?.trim() && language.trim().toLowerCase() !== "auto") args.push("--language", language.trim());

	const device = env("MICME_WHISPER_DEVICE");
	if (device?.trim()) args.push("--device", device.trim());

	const fp16 = env("MICME_WHISPER_FP16");
	if (fp16?.trim()) args.push("--fp16", fp16.trim());
	else args.push("--fp16", "False");

	const result = await runProcess(binary, args, getTranscribeTimeoutMs());
	if (result.code !== 0) {
		throw new Error(`openai-whisper failed (${formatRunExit(result)}):\n${result.stderr || result.stdout}`);
	}

	const txtName = basename(audioPath).replace(/\.[^.]+$/, ".txt");
	const outputPath = join(tempDir, txtName);
	if (existsSync(outputPath)) {
		const fromFile = await readFile(outputPath, "utf8");
		if (fromFile.trim()) return fromFile;
	}

	return result.stdout;
}

export function getWhisperCppBinary() {
	const configured = env("MICME_WHISPER_CPP_BIN")?.trim();
	if (configured) return resolveExecutableConfig(configured, "MICME_WHISPER_CPP_BIN");
	return findExecutable(["whisper-cli", "whisper-cpp"]);
}

export function getWhisperStreamBinary() {
	const configured = env("MICME_WHISPER_STREAM_BIN")?.trim();
	if (configured) return resolveExecutableConfig(configured, "MICME_WHISPER_STREAM_BIN");
	return findExecutable(["whisper-stream"]);
}

export function resolveExecutableConfig(value: string, configName: string) {
	const expanded = expandConfigPath(value);
	if (/[/\\]/.test(expanded)) {
		if (!existsSync(expanded)) throw new Error(`${configName} is set but not found: ${expanded}`);
		return expanded;
	}
	const executable = findExecutable([expanded]);
	if (!executable) throw new Error(`${configName} is set but not found on PATH: ${expanded}`);
	return executable;
}
