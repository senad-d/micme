import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { formatTranscriptionPlan, resolveTranscriptionPlan } from "../backends.ts";
import { getLiveSpeechLanguage, getTranscribeTimeoutMs, getTranslateToEnglishLanguage } from "../config.ts";
import { STATUS_KEY } from "../constants.ts";
import { isRegularFile } from "../models.ts";
import { normalizeTranscript } from "../processes.ts";
import { sanitizeTerminalOutput } from "../terminal-text.ts";
import { transcribeWithWhisperCpp } from "../transcription.ts";
import {
	COMPUTE_MODES,
	type Choice, type ComputeMode, type Ctx, type EntryId, type Final, type Host, type PolishResult,
	type Recognizer, type RecordingDirectory, type Row, type Selection, type Signal, type TransferAction, type TransferOptions, type VerifiedAudio, type Warn,
} from "./contracts.ts";

export async function showTransferAction(ctx: Ctx, host: Host, action: Exclude<TransferAction, "cancel">, signal: Signal) {
	switch (action) {
		case "setup": {
			const { showSetup } = await import("./setup.ts");
			signal.throwIfAborted();
			return showSetup(ctx, host, signal);
		}
		case "history":
		case "import": {
			const { showLibrary } = await import("./history-view.ts");
			signal.throwIfAborted();
			return showLibrary(ctx, action, signal);
		}
		case "polish":
		case "preview": {
			const { showProcessing } = await import("./processing-view.ts");
			signal.throwIfAborted();
			return showProcessing(ctx, host, action, signal);
		}
	}
}

export function installedTrialModel() {
	const plan = resolveTranscriptionPlan({ transcriptionMode: "clip", requestedBackend: "whisper.cpp", customCommand: null, pythonWhisperBinary: null });
	if (plan.effectiveBackend !== "whisper.cpp" || !plan.binary || !plan.modelPath) throw new Error(formatTranscriptionPlan(plan));
	if (!isRegularFile(plan.modelPath)) throw new Error("Micme Try It needs an installed whisper.cpp model. Install or select one in /micme setup first.");
	return { binary: resolve(plan.binary), model: resolve(plan.modelPath) };
}

export async function requireTrialSample(file: string) {
	if (!isAbsolute(file) || !(await lstat(file).catch(() => undefined))?.isFile()) {
		throw new Error("Micme Try It needs an existing local sample file.");
	}
}

export async function transcribeTrial(model: ReturnType<typeof installedTrialModel>, path: string, directory: RecordingDirectory, signal: Signal) {
	return normalizeTranscript(await transcribeWithWhisperCpp(model.binary, model.model, path, directory.filesPath, undefined, {
		allowDownload: false, signal, directory,
	}));
}

export async function showTakeReview(ctx: Ctx, title: string, text: string, signal: Signal) {
	const { Key, matchesKey, wrapTextWithAnsi, truncateToWidth } = await import("../terminal-ui.ts");
	const clean = sanitizeTerminalOutput(text.replace(/\p{Bidi_Control}/gu, ""));
	signal.throwIfAborted();
	ctx.ui.setStatus(STATUS_KEY, undefined);
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		signal.throwIfAborted();
		let top = 0;
		let lastPage = 0;
		const close = () => {
			signal.removeEventListener("abort", close);
			done();
		};
		signal.addEventListener("abort", close, { once: true });
		return {
			invalidate() { /* Render from the current terminal size. */ },
			handleInput(data) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) return close();
				if (matchesKey(data, Key.up)) top = Math.max(0, top - 1);
				else if (matchesKey(data, Key.down)) top = Math.min(lastPage, top + 1);
				else return;
				tui.requestRender();
			},
			render(width) {
				const body = wrapTextWithAnsi(clean, width);
				const rows = Math.max(1, tui.terminal.rows - 4);
				lastPage = Math.max(0, body.length - rows);
				top = Math.min(top, lastPage);
				const help = lastPage ? "↑↓ scroll · Enter/Esc close" : "Enter/Esc close";
				return [theme.fg("accent", truncateToWidth(title, width)), ...body.slice(top, top + rows),
					theme.fg("dim", truncateToWidth(help, width))];
			},
		};
	});
}

export async function selectedChoice(options: TransferOptions, signal: Signal): Promise<Choice> {
	const { listInstalled, listCompute } = await import("./recognition.ts");
	signal.throwIfAborted();
	const variantId = options.MICME_ARTIFACT;
	if (!variantId || !(await listInstalled()).some((choice) => choice.variantId === variantId)) {
		throw new Error("Micme could not use the selected artifact. Select an installed, qualified model in /micme setup.");
	}
	signal.throwIfAborted();
	const requested = options.MICME_COMPUTE;
	const family = COMPUTE_MODES.find((mode) => mode === requested);
	let compute: ComputeMode = family ?? "auto";
	let requestedDeviceId: string | null = null;
	if (requested !== "auto") {
		const devices = await listCompute();
		signal.throwIfAborted();
		const option = devices.find((candidate) => family ? candidate.backend === family : candidate.device?.id === requested);
		if (!option) throw new Error("Micme could not use the requested compute device. Check the available devices in /micme setup.");
		compute = option.backend;
		requestedDeviceId = family ? null : requested;
	}
	const translate = getTranslateToEnglishLanguage();
	return { variantId, compute, requestedDeviceId, language: getLiveSpeechLanguage(translate), task: translate ? "translate-en" : "transcribe",
		detector: options.MICME_DETECTOR, chunking: options.MICME_CHUNKING };
}

// Structurally compatible with Worker v1's PCM sender, but with an independent
// decoder signal. A rejected push must not revoke the session's capture reader.
export class ArtifactDecoder {
	private readonly failed = new AbortController();
	readonly signal: Signal;
	readonly timeoutMs = getTranscribeTimeoutMs();
	through = 0;
	recognizer?: Recognizer;

	constructor(signal: Signal) {
		this.signal = AbortSignal.any([signal, this.failed.signal]);
	}

	get failure(): unknown { return this.signal.reason; }

	fail(error: unknown) { this.failed.abort(error); }

	async send(pcm: Buffer) {
		if (!this.recognizer) throw new Error("Micme lost its selected recognizer.");
		const timer = setTimeout(() => this.fail(new Error("Micme timed out feeding PCM to the selected recognizer.")), this.timeoutMs);
		try {
			await this.recognizer.push(this.through, pcm, this.signal);
			this.signal.throwIfAborted();
			this.through += pcm.length / 2;
		} finally {
			clearTimeout(timer);
		}
	}
}

export async function saveDictation(ctx: Ctx, signal: Signal, source: "clip" | "live", final: Final | null, state: Row["state"], audio: VerifiedAudio | null, model: string | null, polished?: string | null) {
	if (signal.aborted) return null;
	try {
		const { saveTake } = await import("./library.ts");
		signal.throwIfAborted();
		return await saveTake(final, source, state, audio, model, signal, polished);
	} catch {
		if (!signal.aborted) ctx.ui.notify("Micme could not save this take to local history. Session replay is unchanged.", "warning");
		return null;
	}
}

export async function markDeliveryFailed(ctx: Ctx, signal: Signal, row: EntryId | null) {
	if (row === null || signal.aborted) return;
	try {
		const { updateTake } = await import("./library.ts");
		signal.throwIfAborted();
		await updateTake(row, { state: "delivery-failed" }, signal);
	} catch {
		if (!signal.aborted) ctx.ui.notify("Micme could not record the delivery failure in local history.", "warning");
	}
}

export async function preparePolish(final: Final, selection: Selection, signal: Signal): Promise<PolishResult> {
	if (!selection.provider) return { text: final.local, polished: null, warning: "none" };
	try {
		const { polish } = await import("./provider.ts");
		signal.throwIfAborted();
		return await polish(final, selection, signal);
	} catch {
		signal.throwIfAborted();
		return { text: final.local, polished: null, warning: "error" };
	}
}

export function showProcessingWarnings(ctx: Ctx, warnings: readonly Warn[]) {
	for (const { stage, reason } of warnings) {
		const fallback = stage === "polish" ? "using the original local transcript" : "using the text from before the hook";
		const message = reason === "redirect" ? "redirect blocked" : reason === "invalid" ? "invalid response" : reason === "timeout" ? "timed out" : "failed";
		ctx.ui.notify(`Micme ${stage === "polish" ? "polish" : "output hook"}: ${message}; ${fallback}.`, "warning");
	}
}

export function showRuleOutcomes(ctx: Ctx, final: Final) {
	if (!final.rules.length) return;
	const detail = final.rules.map(({ rule, result, reason }) => result === "applied" ? `${rule}: applied` : `${rule}: skipped (${reason})`).join("; ");
	ctx.ui.notify(`Micme local rules — ${sanitizeTerminalOutput(detail)}`, "info");
}
