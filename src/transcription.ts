import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveTranscriptionPlan, formatTranscriptionPlan } from "./backends.ts";
import { env, getTranscribeTimeoutMs, getTranslateToEnglishLanguage } from "./config.ts";
import { ensureWhisperCppModel, getPythonWhisperModelName } from "./models.ts";
import { formatProcessOutput, formatRunExit, runProcess, runShell } from "./processes.ts";

export { getWhisperCppBinary, getWhisperStreamBinary, resolveExecutableConfig } from "./backends.ts";

export async function transcribe(audioPath: string, tempDir: string, ctx?: ExtensionContext, signal?: AbortSignal): Promise<string> {
	const plan = resolveTranscriptionPlan({ transcriptionMode: "clip" });

	switch (plan.effectiveBackend) {
		case "custom":
			if (!plan.command) break;
			return transcribeWithCustomCommand(plan.command, audioPath, tempDir, signal);
		case "whisper.cpp":
			if (!plan.binary || !plan.modelPath) break;
			return transcribeWithWhisperCpp(plan.binary, plan.modelPath, audioPath, tempDir, ctx, { allowDownload: plan.modelDownloadable !== false, signal });
		case "python":
			if (!plan.binary) break;
			return transcribeWithOpenAiWhisper(plan.binary, audioPath, tempDir, plan.modelName, signal);
		case "none":
			break;
	}

	throw new Error(formatTranscriptionPlan(plan));
}

export async function transcribeWithCustomCommand(template: string, audioPath: string, tempDir: string, signal?: AbortSignal) {
	const transcriptPath = join(tempDir, "transcript.txt");
	const result = await runShell(template, getTranscribeTimeoutMs(), {
		signal,
		placeholders: { audio: audioPath, tempDir, transcript: transcriptPath },
	});
	if (result.code !== 0) {
		throw new Error(`MICME_TRANSCRIBE_COMMAND failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	return readTranscriptOutput(transcriptPath, result.stdout);
}

export async function transcribeWithWhisperCpp(
	binary: string,
	modelPath: string,
	audioPath: string,
	tempDir: string,
	ctx?: ExtensionContext,
	options: { allowDownload?: boolean; signal?: AbortSignal } = {},
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

	const result = await runProcess(binary, args, getTranscribeTimeoutMs(), { signal: options.signal });
	if (result.code !== 0) {
		throw new Error(`whisper.cpp failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	return readTranscriptOutput(`${outputBase}.txt`, result.stdout);
}

export async function transcribeWithOpenAiWhisper(binary: string, audioPath: string, tempDir: string, modelName?: string, signal?: AbortSignal) {
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

	const result = await runProcess(binary, args, getTranscribeTimeoutMs(), { signal });
	if (result.code !== 0) {
		throw new Error(`openai-whisper failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	const txtName = basename(audioPath).replace(/\.[^.]+$/, ".txt");
	return readTranscriptOutput(join(tempDir, txtName), result.stdout);
}

async function readTranscriptOutput(path: string, stdout: string) {
	let file;
	try {
		// A blocking open can hang on a FIFO before we can check its type.
		file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return stdout;
		throw error;
	}

	try {
		if (!(await file.stat()).isFile()) throw new Error(`Transcript output is not a regular file: ${path}`);
		const text = await file.readFile("utf8");
		return text.trim() ? text : stdout;
	} finally {
		await file.close();
	}
}
