import { basename, resolve } from "node:path";
import { discoverAudioDevices } from "../audio.ts";
import { getWhisperCppBinary, resolveTranscriptionPlan } from "../backends.ts";
import { env, getAudioInputConfigKey, getAutoDownloadModel, getConfiguredRecorderInput, getLegacyStreamSettings, getShortcut, getTranslateToEnglishLanguage, reloadMicmeConfig, requireValidMicmeConfig, writeMicmeConfigValue } from "../config.ts";
import { formatBytes, formatDownloadProgress, isRegularFile, resolveWhisperCppModel } from "../models.ts";
import { findExecutable } from "../processes.ts";
import { Key, matchesKey, truncateToWidth } from "../terminal-ui.ts";
import { getManagedWhisperVariant, referenceClaim } from "./catalog.ts";
import type { Ctx, ReviewTrial, ShowSetup, Signal } from "./contracts.ts";
import { requireTrialSample, showTakeReview } from "./host.ts";
import { ensureManaged, ManagedModelError, ModelDownloadTimeoutError, removeManaged } from "./managed.ts";
import { catalogPickerRow, checkSetupModelSelection, cleanSettingText, configuredModelLabel, describeVariant, filterSetupCatalog, LANGUAGE_LABELS, selectSetupModel, setupCatalog, showSettingsPicker, SetupMessage, speechLanguageLabel, TRANSLATE_FROM_VALUE_LABELS, TRANSCRIPTION_LANGUAGE_VALUES, whisperModelCompatibility, type CatalogModel, type PickerCursor, type PickerRow } from "./settings.ts";

export const showSetup: ShowSetup = async (ctx, host, signal) => {
	if (ctx.mode !== "tui" || signal.aborted) return;
	const state = reloadMicmeConfig();
	if (state.error) {
		ctx.ui.notify(`Micme setup: ${cleanSettingText(state.error)}. Repair micme.json, then reopen setup.`, "warning");
		return;
	}
	const cursor: PickerCursor = {};
	while (!signal.aborted) {
		const setup = readSetup();
		const choice = await showSettingsPicker(ctx, signal, { title: "Micme Setup", heading: setup.headings, rows: setup.rows, cursor });
		if (!choice || signal.aborted) return;
		try {
			switch (choice) {
				case "prerequisites": await showPrerequisites(ctx, signal, setup); break;
				case "language": await chooseLanguage(ctx, signal, false); break;
				case "translate": await chooseLanguage(ctx, signal, true); break;
				case "models": await showCatalog(ctx, signal); break;
				case "microphone": await chooseMicrophone(ctx, signal); break;
				case "sample": case "mic": {
					const input = await confirmTrial(ctx, signal, choice);
					if (!input) break;
					signal.throwIfAborted();
					// Setup is already closed. The session signal outlives this view so an
					// armed mic trial remains stoppable by the ordinary Micme toggle.
					return await host.startReviewTrial(input, signal);
				}
			}
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(setupError(error), "warning");
		}
	}
};

function readSetup() {
	const model = resolveWhisperCppModel();
	const language = env("MICME_LANGUAGE")?.trim().toLowerCase() || "en";
	const translation = getTranslateToEnglishLanguage();
	const speech = speechLanguageLabel(language);
	const task = translation ? `From ${speechLanguageLabel(translation)}` : "Off";
	const customRecorder = Boolean(env("MICME_RECORD_COMMAND")?.trim());
	const recorderAvailable = customRecorder || Boolean(findExecutable(["ffmpeg"]));
	let binaryAvailable = false;
	try { binaryAvailable = Boolean(getWhisperCppBinary()); } catch { /* Show the fixed repair, not a configured path. */ }
	const input = customRecorder ? "Custom recorder" : getConfiguredRecorderInput(process.platform) || "Automatic";
	const legacy = getLegacyStreamSettings();
	return {
		model, binaryAvailable, recorderAvailable, customRecorder, input, legacy,
		headings: [binaryAvailable ? "Local Whisper CLI found · mic not tested" : "Whisper CLI missing · see prerequisites"],
		rows: [
			{ value: "prerequisites", label: "Prerequisites and SDL migration" },
			{ value: "language", label: "Speech language", description: speech, details: [`Transcription source: ${speech}. Translation has its own source.`] },
			{ value: "translate", label: "Translate to English", description: task, details: [`Translation: ${task}.`] },
			{ value: "models", label: "Models and repair", description: model.modelName ?? configuredModelLabel(model.path), details: [
				`Selected: ${configuredModelLabel(model.path)} · ${model.exists ? "found, not verified in this view" : "missing"}.`,
			] },
			{ value: "microphone", label: "Microphone input", description: input, details: [`Requested: ${input}. Actual device and channel: unknown until capture.`] },
			{ value: "sample", label: "Try It: local sample", details: ["Review only. No mic or prompt changes."] },
			{ value: "mic", label: "Try It: microphone", details: ["Separate confirmation. Stop with the usual toggle; review only."] },
		] satisfies PickerRow[],
	};
}

const whisperRepair = "Install whisper-cli (whisper.cpp), or correct MICME_WHISPER_CPP_BIN. Try It does not require the live worker.";
const recorderRepair = "Install FFmpeg or configure a trusted MICME_RECORD_COMMAND before trying the microphone. Local sample review does not use the recorder.";

async function showPrerequisites(ctx: Ctx, signal: Signal, setup: ReturnType<typeof readSetup>) {
	const live = resolveTranscriptionPlan({ transcriptionMode: "stream", requestedBackend: "whisper.cpp" });
	const lines = [
		setup.binaryAvailable ? "Whisper CLI: executable found. No model load performed." : whisperRepair,
		setup.recorderAvailable ? `Requested input: ${setup.input}. Actual device, channel, fallback and permissions not tested.` : recorderRepair,
		live.live ? "Live worker path resolved; protocol and capture not tested here." : "Live prerequisites incomplete. Run micme-doctor for worker or task diagnostics. This does not indicate mic failure.",
		...(setup.legacy.length ? ["Legacy SDL settings were found and are unchanged. Install micme-live and set MICME_LIVE_BIN for stream mode, or choose clip mode in /micme conf."] : []),
		"If capture is denied, check your terminal's microphone permission and the selected input in your OS. Preview never opens a mic or changes permissions.",
		"Run micme-doctor for a standalone offline check.",
	];
	await showTakeReview(ctx, "Setup · Prerequisites", lines.map(cleanSettingText).join("\n\n"), signal);
}

async function chooseLanguage(ctx: Ctx, signal: Signal, translate: boolean) {
	const id = translate ? "MICME_TRANSLATE_TO_ENGLISH" : "MICME_LANGUAGE";
	if (process.env[id] !== undefined) throw new SetupMessage(`Shell override: change ${id} in the shell to edit this choice.`);
	const values = translate ? Object.keys(TRANSLATE_FROM_VALUE_LABELS) : TRANSCRIPTION_LANGUAGE_VALUES;
	const labels = translate ? TRANSLATE_FROM_VALUE_LABELS : LANGUAGE_LABELS;
	const choices = values.map((value) => ({ value, label: labels[value] ?? value }));
	const selected = translate ? getTranslateToEnglishLanguage() ?? "off" : env(id)?.trim() || "en";
	const value = await showSettingsPicker(ctx, signal, { title: translate ? "Translate to English from" : "Speech language", rows: choices, cursor: { selected }, searchHint: "Type to search languages" });
	if (value === undefined || signal.aborted) return;
	const model = resolveWhisperCppModel();
	const translation = translate ? (value === "off" ? undefined : value) : getTranslateToEnglishLanguage();
	const language = translation ?? (translate ? env("MICME_LANGUAGE")?.trim().toLowerCase() || "en" : value);
	const problem = whisperModelCompatibility(model.modelName, language, Boolean(translation));
	await saveSetupPreference(id, value, signal);
	if (!signal.aborted && problem && model.configuredValue) {
		ctx.ui.notify(`${problem} This choice is saved; select a compatible model before Try It.`, "info");
	}
}

async function chooseMicrophone(ctx: Ctx, signal: Signal) {
	const setup = readSetup();
	const id = getAudioInputConfigKey(process.platform);
	if (setup.customRecorder) throw new SetupMessage("A custom recorder controls the input. Change MICME_RECORD_COMMAND manually; the picker cannot override it.");
	if (!setup.recorderAvailable) throw new SetupMessage(recorderRepair);
	if (process.env[id] !== undefined || (process.platform === "darwin" && env("MICME_AVFOUNDATION_INPUT")?.trim())) {
		throw new SetupMessage("The microphone selection is overridden by the shell or MICME_AVFOUNDATION_INPUT. Change that setting first.");
	}
	const devices = await discoverAudioDevices(signal);
	signal.throwIfAborted();
	const defaults = { linux: "default", darwin: "0", win32: "" };
	const fallback = process.platform in defaults ? defaults[process.platform as keyof typeof defaults] : "";
	const rows = [{ label: "System default", value: fallback }, ...devices.filter(({ value }) => value !== fallback)];
	const value = await showSettingsPicker(ctx, signal, {
		title: "Requested microphone input", rows, cursor: { selected: env(id) || fallback },
		heading: ["Actual device and route are not tested."],
	});
	if (value !== undefined && !signal.aborted) await saveSetupPreference(id, value, signal);
}

async function confirmSetupAction(ctx: Ctx, signal: Signal, title: string, message: string, action: string) {
	return await showSettingsPicker(ctx, signal, {
		title, heading: [message], rows: [{ label: "Cancel", value: "cancel" }, { label: action, value: "confirm" }],
	}) === "confirm";
}

async function saveSetupPreference(id: string, value: string, signal: Signal) {
	signal.throwIfAborted();
	requireValidMicmeConfig();
	await writeMicmeConfigValue(id, value, { signal });
}

async function showCatalog(ctx: Ctx, signal: Signal) {
	const cursor: PickerCursor = {};
	while (!signal.aborted) {
		const models = setupCatalog(ctx.cwd);
		const key = await showSettingsPicker(ctx, signal, {
			title: "Speech model catalog", heading: [`${models.filter(({ group }) => group === "reference").length} Handy reference entries · not download offers`],
			rows: [], cursor, filter: (query) => filterSetupCatalog(models, query).map(catalogPickerRow),
			searchHint: "Type to filter: names, lang:en, installed (local file), stream, translate",
		});
		if (!key || signal.aborted) return;
		const model = models.find((item) => item.key === key);
		if (!model) continue;
		try {
			if (model.group === "reference") await showReference(ctx, signal, model);
			else if (await manageWhisper(ctx, signal, model)) return;
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(setupError(error), "warning");
		}
	}
}

async function showReference(ctx: Ctx, signal: Signal, model: CatalogModel) {
	const claim = referenceClaim(model.key);
	const variants = model.variants.map((variant) => ({ label: variant.quant ?? "Unknown quantization", value: variant.id }));
	const selected = variants.length > 1 ? await showSettingsPicker(ctx, signal, {
		title: model.label, rows: variants, heading: ["Reference variants · select to inspect"], cursor: { selected: variants.find(({ label }) => label === claim?.defaultQuant)?.value },
	}) : variants[0]?.value;
	const variant = model.variants.find(({ id }) => id === selected);
	if (!variant || signal.aborted) return;
	const details = [
		`Handy v0.10.2 reference: ${model.label} (${variant.quant ?? "unknown"}). ${claim?.curated ? "Curated" : "Search-only"} in Handy.`,
		...(claim ? [`Source: ${claim.repository}.`, `Tagged revision: ${claim.revision}.`] : []),
		...describeVariant(variant),
		"Not selectable for the local Whisper Try It. Reference claims are not runtime observations.",
	];
	await showTakeReview(ctx, "Reference · Exact variant", details.join("\n\n"), signal);
}

async function manageWhisper(ctx: Ctx, signal: Signal, model: CatalogModel) {
	const cursor: PickerCursor = {};
	let verified = false;
	const variant = model.name && model.group === "whisper" ? getManagedWhisperVariant(model.name) : null;
	while (!signal.aborted) {
		const choices: PickerRow[] = [{ label: "Use for Whisper dictation", value: "use" }];
		if (variant) choices.push({ label: "Verify local weights", value: "verify" }, { label: "Published model evidence", value: "evidence" }, { label: "Remove Micme-owned files", value: "remove" });
		choices.push({ label: "Back to models", value: "back" });
		const status = variant ? (verified ? "Verified during this visit · checks run again before use" : "Managed · bytes not yet verified") : "Manual file · integrity and rights not verified by Micme";
		const compatibility = whisperModelCompatibility(model.name);
		const action = await showSettingsPicker(ctx, signal, {
			title: model.label, rows: choices, cursor, heading: [status,
				...(compatibility ? [compatibility] : []),
				...(variant ? [`Rights: ${variant.rights}. Clip smoke: ${variant.runtime} (see evidence).`] : []),
			],
		});
		if (action === undefined || signal.aborted || action === "back") return false;
		try {
			if (action === "remove" && variant) {
				if (await confirmSetupAction(ctx, signal, "Remove managed model?", `Remove only Micme-owned files or partials for ${model.label}? Your selection and manually placed files are preserved.`, "Remove owned files")) {
					await removeManaged(variant, signal);
					verified = false;
					ctx.ui.notify("Managed model removal check completed. No settings changed.", "info");
				}
				continue;
			}
			if (action === "evidence" && variant) {
				await showTakeReview(ctx, "Model · Published evidence", describeVariant(variant).join("\n\n"), signal);
				continue;
			}
			if (action === "use") {
				if (compatibility) throw new SetupMessage(compatibility);
				checkSetupModelSelection(model.group);
			}
			if (!variant && (!model.path || !isRegularFile(model.path))) throw new SetupMessage("The manual model is missing. Install the file or select managed Whisper weights.");
			if (variant) {
				verified = false;
				verified = Boolean(await prepareManaged(ctx, signal, variant, action === "use"));
				if (!verified) continue;
			}
			if (action === "verify") continue;
			await selectSetupModel(model, signal);
			ctx.ui.notify(variant ? "Verified model selected by name." : "Manual Whisper file selected; not a verified managed model.", "info");
			return true;
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(setupError(error), "warning");
		}
	}
	return false;
}

async function prepareManaged(ctx: Ctx, signal: Signal, variant: NonNullable<ReturnType<typeof getManagedWhisperVariant>>, allowPrompt: boolean) {
	try {
		return await modelProgress(ctx, signal, "Verifying local model…", (operationSignal, progress) => ensureManaged(variant, false, progress, operationSignal));
	} catch (error) {
		if (!allowPrompt || !(error instanceof ManagedModelError) || error.code !== "missing") throw error;
		if (!getAutoDownloadModel()) throw new SetupMessage("Model missing. Automatic downloads are disabled. Install the exact pinned weights offline or choose another model.");
		const bytes = variant.blobs.reduce((sum, blob) => sum + blob.bytes, 0);
		if (!await confirmSetupAction(ctx, signal, "Authorize model download?", `Download ${variant.blobs[0].path} (${formatBytes(bytes)}) from ${new URL(variant.blobs[0].url).hostname}? Verify size and SHA-256 before use.`, "Download and verify")) return;
		requireValidMicmeConfig();
		return modelProgress(ctx, signal, "Downloading model…", (operationSignal, progress) => ensureManaged(variant, true, progress, operationSignal));
	}
}

type ModelResult = { path?: string; error?: unknown };
async function modelProgress(ctx: Ctx, signal: Signal, title: string, task: (signal: Signal, progress: (got: number, total: number) => void) => Promise<string>) {
	signal.throwIfAborted();
	const result = await ctx.ui.custom<ModelResult>((tui, theme, _keys, done) => {
		signal.throwIfAborted();
		const cancel = new AbortController();
		const operationSignal = AbortSignal.any([signal, cancel.signal]);
		let status = title;
		let rendered = -1;
		const progress = (got: number, total: number) => {
			if (operationSignal.aborted || !total) return;
			const percent = Math.floor(100 * got / total);
			if (rendered === percent) return;
			rendered = percent;
			status = `${title} ${formatDownloadProgress(got, total)}`;
			tui.requestRender();
		};
		const finish = (result: ModelResult) => done(operationSignal.aborted ? {} : result);
		void task(operationSignal, progress).then((path) => finish({ path }), (error: unknown) => finish({ error }));
		return {
			render: (width) => [theme.fg("accent", truncateToWidth(status, width)), truncateToWidth("Esc to cancel", width)],
			invalidate() { /* No cached terminal size. */ },
			handleInput(data) {
				if (!matchesKey(data, Key.escape) && !matchesKey(data, Key.ctrl("c"))) return;
				cancel.abort();
				status = "Canceling model operation…";
				tui.requestRender();
			},
		};
	});
	signal.throwIfAborted();
	if (result.error !== undefined) throw result.error;
	return result.path;
}

async function confirmTrial(ctx: Ctx, signal: Signal, kind: ReviewTrial["kind"]): Promise<ReviewTrial | undefined> {
	requireValidMicmeConfig();
	const setup = readSetup();
	if (!setup.binaryAvailable) throw new SetupMessage(whisperRepair);
	if (kind === "mic" && !setup.recorderAvailable) throw new SetupMessage(recorderRepair);
	const { model } = setup;
	if (model.configuredValue && model.translationFallbackFrom) throw new SetupMessage("The configured Whisper model cannot translate to English. Choose a translation-capable model explicitly, or turn translation off.");
	const incompatible = whisperModelCompatibility(model.modelName);
	if (incompatible) throw new SetupMessage(incompatible);
	const variant = model.downloadable && model.modelName ? getManagedWhisperVariant(model.modelName) : null;
	if (variant) {
		if (!await prepareManaged(ctx, signal, variant, false)) return;
	} else if (!model.exists) {
		throw new SetupMessage("Whisper model missing. Open Models and repair to select installed weights or authorize a download. Try It is offline.");
	}
	if (kind === "mic") {
		const confirmed = await confirmSetupAction(ctx, signal, "Try microphone?", `Stop with ${cleanSettingText(getShortcut())} or /micme. This take is for review only; nothing is pasted, sent or queued.`, "Start recording");
		return confirmed ? { kind } : undefined;
	}
	const path = await ctx.ui.input("Local sample WAV path · review only", "Absolute or project-relative file", { signal });
	if (!path?.trim() || signal.aborted) return;
	const file = resolve(ctx.cwd, path.trim());
	try { await requireTrialSample(file); }
	catch { throw new SetupMessage("Sample missing or not a regular file. Choose an existing local WAV; no URL or mic is used."); }
	const confirmed = await confirmSetupAction(ctx, signal, "Review local sample?", `Transcribe ${cleanSettingText(basename(file))} locally? Nothing is pasted, sent or queued.`, "Transcribe sample");
	return confirmed ? { kind, file } : undefined;
}

function setupError(error: unknown) {
	if (error instanceof SetupMessage) return error.message;
	if (error instanceof ModelDownloadTimeoutError) return "Model transfer stopped making progress. Retry to resume if the source supports it, or install the exact weights offline.";
	if (error instanceof ManagedModelError) {
		switch (error.code) {
			case "missing": return "Whisper model missing. Use Models and repair to authorize download if enabled, or install the exact pinned weights offline.";
			case "integrity": return "Whisper weights failed verification. Use Remove Micme-owned files, or replace a manually placed file with the exact pinned weights.";
			case "unowned": return "This file is not Micme-owned. No files removed. Move or replace a manually installed copy yourself.";
			case "unsafe": return "Unsafe model-cache path. Use a private cache directory and ordinary verified files; no unsafe entry is replaced.";
			case "unqualified": return "This exact artifact does not have qualified load and rights evidence. Choose a supported Whisper model.";
			case "busy": return "Model operation still in progress. Wait or cancel it before retrying.";
		}
	}
	return "Micme setup could not complete this step. Check micme.json, the installed files, or micme-doctor and try again.";
}
