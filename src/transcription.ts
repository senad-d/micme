import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveTranscriptionPlan, formatTranscriptionPlan } from "./backends.ts";
import { env, getTranscribeTimeoutMs, getTranslateToEnglishLanguage } from "./config.ts";
import { ensureWhisperCppModel, getPythonWhisperModelName } from "./models.ts";
import { formatProcessOutput, formatRunExit, replacePlaceholders, runProcess, runShell } from "./processes.ts";

export { getWhisperCppBinary, getWhisperStreamBinary, resolveExecutableConfig } from "./backends.ts";

export async function transcribe(audioPath: string, tempDir: string, ctx?: ExtensionContext): Promise<string> {
	const plan = resolveTranscriptionPlan({ transcriptionMode: "clip" });

	switch (plan.effectiveBackend) {
		case "custom":
			if (!plan.command) break;
			return transcribeWithCustomCommand(plan.command, audioPath, tempDir);
		case "whisper.cpp":
			if (!plan.binary || !plan.modelPath) break;
			return transcribeWithWhisperCpp(plan.binary, plan.modelPath, audioPath, tempDir, ctx, { allowDownload: plan.modelDownloadable !== false });
		case "python":
			if (!plan.binary) break;
			return transcribeWithOpenAiWhisper(plan.binary, audioPath, tempDir, plan.modelName);
		case "none":
			break;
	}

	throw new Error(formatTranscriptionPlan(plan));
}

export async function transcribeWithCustomCommand(template: string, audioPath: string, tempDir: string) {
	const transcriptPath = join(tempDir, "transcript.txt");
	const command = replacePlaceholders(template, { audio: audioPath, tempDir, transcript: transcriptPath });
	const result = await runShell(command, getTranscribeTimeoutMs());
	if (result.code !== 0) {
		throw new Error(`MICME_TRANSCRIBE_COMMAND failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	if (existsSync(transcriptPath)) {
		const fromFile = await readFile(transcriptPath, "utf8");
		if (fromFile.trim()) return fromFile;
	}

	return result.stdout;
}

export async function transcribeWithWhisperCpp(
	binary: string,
	modelPath: string,
	audioPath: string,
	tempDir: string,
	ctx?: ExtensionContext,
	options: { allowDownload?: boolean } = {},
) {
	await ensureWhisperCppModel(modelPath, ctx, options);
	const outputBase = join(tempDir, "whisper-cpp");
	const args = ["-m", modelPath, "-f", audioPath, "-otxt", "-of", outputBase, "-nt", "-np", "-nf", "-sns"];
	const translateLanguage = getTranslateToEnglishLanguage();
	if (translateLanguage) {
		args.push("-tr", "-l", translateLanguage);
	} else {
		const language = env("MICME_LANGUAGE");
		if (language?.trim()) args.push("-l", language.trim());
	}

	const result = await runProcess(binary, args, getTranscribeTimeoutMs());
	if (result.code !== 0) {
		throw new Error(`whisper.cpp failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	const outputPath = `${outputBase}.txt`;
	if (existsSync(outputPath)) {
		const fromFile = await readFile(outputPath, "utf8");
		if (fromFile.trim()) return fromFile;
	}

	return result.stdout;
}

export async function transcribeWithOpenAiWhisper(binary: string, audioPath: string, tempDir: string, modelName?: string) {
	const model = modelName || getPythonWhisperModelName();
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

	const translateLanguage = getTranslateToEnglishLanguage();
	if (translateLanguage) {
		args.push("--task", "translate", "--language", translateLanguage);
	} else {
		const language = env("MICME_LANGUAGE");
		if (language?.trim() && language.trim().toLowerCase() !== "auto") args.push("--language", language.trim());
	}

	const device = env("MICME_WHISPER_DEVICE");
	if (device?.trim()) args.push("--device", device.trim());

	const fp16 = env("MICME_WHISPER_FP16");
	if (fp16?.trim()) args.push("--fp16", fp16.trim());
	else args.push("--fp16", "False");

	const result = await runProcess(binary, args, getTranscribeTimeoutMs());
	if (result.code !== 0) {
		throw new Error(`openai-whisper failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	const txtName = basename(audioPath).replace(/\.[^.]+$/, ".txt");
	const outputPath = join(tempDir, txtName);
	if (existsSync(outputPath)) {
		const fromFile = await readFile(outputPath, "utf8");
		if (fromFile.trim()) return fromFile;
	}

	return result.stdout;
}
