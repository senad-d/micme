import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, readFile } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveTranscriptionPlan, formatTranscriptionPlan } from "./backends.ts";
import { env, getTranscribeTimeoutMs, getTranslateToEnglishLanguage } from "./config.ts";
import { MAX_CAPTURED_OUTPUT_CHARS } from "./constants.ts";
import { ensureWhisperCppModel, getPythonWhisperModelName } from "./models.ts";
import { formatProcessOutput, formatRunExit, runProcess, runShell } from "./processes.ts";
import type { RecordingDirectory } from "./recording-dir.ts";
import type { Choice, Traits } from "./transfer/contracts.ts";
import type { RunResult } from "./types.ts";

export { getWhisperCppBinary, resolveExecutableConfig } from "./backends.ts";
export { resolveLivePlan } from "./live-plan.ts";

export async function transcribe(audioPath: string, tempDir: string, ctx?: ExtensionContext, signal?: AbortSignal, directory?: RecordingDirectory): Promise<string> {
	const plan = resolveTranscriptionPlan({ transcriptionMode: "clip" });

	switch (plan.effectiveBackend) {
		case "custom":
			if (!plan.command) break;
			return transcribeWithCustomCommand(plan.command, audioPath, tempDir, signal, directory);
		case "whisper.cpp":
			if (!plan.binary || !plan.modelPath) break;
			return transcribeWithWhisperCpp(plan.binary, plan.modelPath, audioPath, tempDir, ctx, { allowDownload: plan.modelDownloadable !== false, signal, directory });
		case "python":
			if (!plan.binary) break;
			return transcribeWithOpenAiWhisper(plan.binary, audioPath, tempDir, plan.modelName, signal, directory);
		case "none":
			break;
	}

	throw new Error(formatTranscriptionPlan(plan));
}

export async function transcribeWithCustomCommand(template: string, audioPath: string, tempDir: string, signal?: AbortSignal, directory?: RecordingDirectory) {
	const transcriptPath = join(tempDir, "transcript.txt");
	const result = await runShell(template, getTranscribeTimeoutMs(), {
		signal,
		cwdFd: directory?.cwdFd,
		placeholders: { audio: audioPath, tempDir, transcript: transcriptPath },
	});
	if (result.code !== 0) {
		throw new Error(`MICME_TRANSCRIBE_COMMAND failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	return readTranscriptOutput(transcriptPath, result, directory);
}

type WhisperCppOptions = { allowDownload?: boolean; signal?: AbortSignal; directory?: RecordingDirectory };
type FileWhisperChoice = Pick<Choice, "language" | "task" | "compute">;

export async function transcribeWithWhisperCpp(
	binary: string,
	modelPath: string,
	audioPath: string,
	tempDir: string,
	ctx?: ExtensionContext,
	options: WhisperCppOptions = {},
) {
	return (await runWhisperCpp(binary, modelPath, audioPath, tempDir, options, ctx)).text;
}

/** Installed file jobs never inherit the ambient language/task or download policy. */
export async function transcribeInstalledWhisper(binary: string, model: string, audio: string, directory: RecordingDirectory, choice: FileWhisperChoice, signal: AbortSignal) {
	return runWhisperCpp(binary, model, audio, directory.filesPath, { directory, signal, allowDownload: false }, undefined, choice);
}

function observedWhisperCompute(stderr: string): Traits["actualCompute"] {
	if (/whisper_backend_init(?:_gpu)?: failed to initialize/iu.test(stderr)) return "unknown";
	if (/whisper_backend_init_gpu: using .*Metal|ggml_backend_metal_device_init:.*using/iu.test(stderr)) return "metal";
	if (/whisper_backend_init_gpu: using .*Vulkan/iu.test(stderr)) return "vulkan";
	if (/whisper_backend_init: using (?!CPU\b)/iu.test(stderr)) return "unknown";
	if (/whisper_backend_init_gpu: no GPU found|whisper_backend_init: using CPU backend/iu.test(stderr)) return "cpu";
	return "unknown";
}

async function runWhisperCpp(binary: string, modelPath: string, audioPath: string, tempDir: string, options: WhisperCppOptions,
	ctx?: ExtensionContext, choice?: FileWhisperChoice) {
	await ensureWhisperCppModel(modelPath, ctx, options);
	const outputBase = join(tempDir, choice ? `whisper-${randomUUID()}` : "whisper-cpp");
	const model = options.directory?.cwdFd === undefined ? modelPath : resolve(modelPath);
	const args = ["-m", model, "-f", audioPath, "-otxt", "-of", outputBase, "-nt", ...(!choice ? ["-np"] : []), "-nf", "-sns"];
	const translateLanguage = choice ? undefined : getTranslateToEnglishLanguage();
	if (choice) {
		if (choice.compute === "cpu") args.push("-ng");
		if (choice.task === "translate-en") args.push("-tr");
		args.push("-l", choice.language);
	} else if (translateLanguage) {
		args.push("-tr", "-l", translateLanguage);
	} else {
		const language = env("MICME_LANGUAGE");
		if (language?.trim()) args.push("-l", language.trim());
	}

	const result = await runProcess(binary, args, getTranscribeTimeoutMs(), { signal: options.signal, cwdFd: options.directory?.cwdFd });
	if (result.code !== 0) {
		throw new Error(`whisper.cpp failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	const actualCompute = choice ? observedWhisperCompute(result.stderr) : "unknown";
	if (choice && choice.compute !== "auto" && actualCompute !== choice.compute) throw new Error("whisper.cpp did not confirm the selected compute backend.");
	return { text: await readTranscriptOutput(`${outputBase}.txt`, result, options.directory), actualCompute, boundDevice: null } as const;
}

export async function transcribeWithOpenAiWhisper(binary: string, audioPath: string, tempDir: string, modelName?: string, signal?: AbortSignal, directory?: RecordingDirectory) {
	const model = modelName || getPythonWhisperModelName();
	const args = [
		audioPath,
		"--model",
		directory?.cwdFd !== undefined && (model.includes("/") || model.endsWith(".pt")) ? resolve(model) : model,
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

	const result = await runProcess(binary, args, getTranscribeTimeoutMs(), { signal, cwdFd: directory?.cwdFd });
	if (result.code !== 0) {
		throw new Error(`openai-whisper failed (${formatRunExit(result)}):\n${formatProcessOutput(result.stderr, result.stdout)}`);
	}

	const txtName = basename(audioPath).replace(/\.[^.]+$/, ".txt");
	return readTranscriptOutput(join(tempDir, txtName), result, directory);
}

async function readTranscriptOutput(path: string, result: RunResult, directory?: RecordingDirectory): Promise<string> {
	const text = await readTranscriptFile(path, directory);
	if (text?.trim()) return text;

	if (result.stdoutTruncated) {
		throw new Error(`Transcriber stdout exceeded the ${MAX_CAPTURED_OUTPUT_CHARS}-character capture limit and was truncated. Write the transcript to the output file instead.`);
	}
	return result.stdout;
}

const readOpenFile = promisify(readFile);

async function readTranscriptFile(path: string, directory?: RecordingDirectory): Promise<string | undefined> {
	try {
		// A blocking open can hang on a FIFO before we can check its type.
		const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
		if (directory) return await readOwnedTranscript(path, directory.openFile(path, flags));
		const file = await open(path, flags);
		try {
			if (!(await file.stat()).isFile()) throw new Error(`Transcript output is not a regular file: ${path}`);
			return await file.readFile("utf8");
		} finally {
			await file.close();
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readOwnedTranscript(path: string, fd: number) {
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Transcript output is not a regular file: ${path}`);
		return await readOpenFile(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
