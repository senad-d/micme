import { basename, isAbsolute, resolve, sep } from "node:path";
import { installedWhisperModels, resolveTranscriptionPlan } from "../backends.ts";
import { getLiveSpeechLanguage, getTranscriptionMode, getTransferOptions, getTranslateToEnglishLanguage, writeMicmeConfigValue } from "../config.ts";
import { resolveWhisperCppModel } from "../models.ts";
import { stripTerminalControlSequences } from "../terminal-text.ts";
import { decodeKittyPrintable, Editor, isKeyRelease, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "../terminal-ui.ts";
import {
	LIBRARY_PAGE_SIZE, RETENTION_DAYS, type CancelJob, type Choice, type Ctx, type EntryId,
	type ImportFiles, type LibraryAction, type Row, type ShowLibrary, type Signal,
} from "./contracts.ts";
import { selectedChoice } from "./host.ts";
import * as library from "./library.ts";
import { parseRetentionPolicy } from "./options.ts";
import { listInstalled } from "./recognition.ts";
import { applyPrune, previewPrune } from "./retention.ts";

const ROW_STATE: Record<Row["state"], string> = {
	queued: "Queued", decoding: "Decoding", recognizing: "Transcribing", ready: "Ready",
	"asr-failed": "Recognition failed", "delivery-failed": "Delivery failed", interrupted: "Interrupted",
	canceled: "Canceled", "save-failed": "Storage failed",
};
const TRANSCRIPTS = [["raw", "Original"], ["local", "Local"], ["polished", "Polished"]] as const;
const NAVIGATION = "↑↓ select · Enter open · Esc back";
const POLL_MS = 500;
const LIBRARY_ERROR = "Storage error. Could not read local history.";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const UNSAFE_INPUT = /[\x00-\x09\x0b-\x1f\x7f-\x9f]|\p{Bidi_Control}/u;

type Tui = Parameters<Parameters<Ctx["ui"]["custom"]>[0]>[0];
type Theme = Ctx["ui"]["theme"];
type Item = { label: string; run: () => void; id?: EntryId };
type Menu = { title: string; body?: string; items: Item[] };
type Panel =
	| { kind: "list" }
	| { kind: "take"; id: EntryId }
	| { kind: "menu"; menu: Menu }
	| { kind: "text"; title: string; text: string; copy?: () => void; top: number; wrapped?: { width: number; lines: string[] } }
	| { kind: "input"; title: string; prompt: string; multiple: boolean; editor: InstanceType<typeof Editor>; accept: (text: string) => void };
type Frame = { panel: Panel; index: number; id?: EntryId };
type Work = { label: string; controller: AbortController; done?: Promise<void>; cancel?: string };
type Playback = { fromMs: number; controller: AbortController; done: Promise<void> };

async function copyWithHost(text: string) {
	const hostPackage = "@earendil-works/pi-coding-agent";
	const host: typeof import("@earendil-works/pi-coding-agent") = await import(hostPackage);
	if (typeof host.copyToClipboard !== "function") throw new Error("No host clipboard facility");
	await host.copyToClipboard(text);
}

// Import ships independently. The scaffold may still be present in an earlier phase.
async function localImport(): Promise<{ files: ImportFiles; cancel: CancelJob }> {
	const api: { importFiles?: ImportFiles; cancelJob?: CancelJob } = await import("./import.ts") as object;
	if (!api.importFiles || !api.cancelJob) throw new Error("Media import is unavailable");
	return { files: api.importFiles, cancel: api.cancelJob };
}

export async function currentLibraryModel(signal: Signal): Promise<Choice> {
	signal.throwIfAborted();
	const options = getTransferOptions();
	if (options.MICME_ARTIFACT) return selectedChoice(options, signal);
	// A file retry needs the selected weights, not the live worker or its VAD.
	const plan = resolveTranscriptionPlan(getTranscriptionMode() === "stream" ? {
		transcriptionMode: "clip", customCommand: null, pythonWhisperBinary: null, whisperCppModel: resolveWhisperCppModel({ transcriptionMode: "stream" }),
	} : { transcriptionMode: "clip" });
	const modelPath = plan.modelPath ? resolve(plan.modelPath) : undefined;
	const model = modelPath && installedWhisperModels().find(({ path }) => path === modelPath);
	const compute = options.MICME_COMPUTE;
	if (plan.effectiveBackend !== "whisper.cpp" || !model || (compute !== "auto" && compute !== "cpu")) {
		throw new Error("No supported current installed model");
	}
	const translate = getTranslateToEnglishLanguage();
	return { variantId: model.id, compute, requestedDeviceId: null, language: getLiveSpeechLanguage(translate),
		task: translate ? "translate-en" : "transcribe", detector: "off", chunking: true };
}

const services = {
	enabled: () => getTransferOptions().MICME_HISTORY,
	setEnabled: (enabled: boolean, signal: Signal) => writeMicmeConfigValue("MICME_HISTORY", enabled ? "1" : "0", { signal }),
	proposedRetention: () => getTransferOptions().MICME_RETENTION,
	page: library.page, verifiedAudio: library.verifiedAudio, play: library.play, star: library.star, deleteRow: library.deleteRow,
	retry: library.retry, previewPrune, applyPrune, currentModel: currentLibraryModel, listInstalled, localImport, copy: copyWithHost,
};

export const showLibrary: ShowLibrary = async (ctx, action, signal) => {
	if (ctx.mode !== "tui" || signal.aborted) return;
	let screen: LibraryScreen | undefined;
	try {
		// A capturing overlay restores the existing composer, including its cursor,
		// without the inline custom dialog's save-and-replace of the editor text.
		await ctx.ui.custom<void>((tui, theme, _keys, done) => {
			signal.throwIfAborted();
			screen = new LibraryScreen(ctx.cwd, action, tui, theme, signal, done);
			return screen;
		}, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } });
	} finally {
		await screen?.finish();
	}
};

export class LibraryScreen {
	readonly capturesViewportInput = true;
	private readonly frames: Frame[] = [{ panel: { kind: "list" }, index: 0 }];
	private readonly cursors: (EntryId | null)[] = [null];
	private rows: Row[] = [];
	private enabled?: boolean;
	private readFailed = false;
	private closed = false;
	private notice = "";
	private audio?: { id: EntryId; hash: string; available: boolean };
	private work?: Work;
	private playback?: Playback;
	private polling = false;
	private importsPending = 0;
	private refreshing = 0;
	private textPage = 1;
	private textBottom = 0;
	private readonly pollTimer: ReturnType<typeof setInterval>;
	private readonly cwd: string;
	private readonly action: LibraryAction;
	private readonly tui: Tui;
	private readonly theme: Theme;
	private readonly parent: Signal;
	private readonly done: () => void;
	private readonly api: typeof services;

	constructor(cwd: string, action: LibraryAction, tui: Tui, theme: Theme, parent: Signal, done: () => void, api = services) {
		this.cwd = cwd;
		this.action = action;
		this.tui = tui;
		this.theme = theme;
		this.parent = parent;
		this.done = done;
		this.api = api;
		parent.addEventListener("abort", this.close, { once: true });
		this.pollTimer = setInterval(this.poll, POLL_MS);
		this.pollTimer.unref();
		this.run("Opening local library…", "Settings error. Check micme.json and shell overrides.", this.open.bind(this));
	}

	invalidate() { this.editor()?.invalidate(); }
	get focused() { return this.editor()?.focused ?? true; }
	set focused(value: boolean) { const editor = this.editor(); if (editor) editor.focused = value; }

	handleInput(data: string) {
		if (this.closed || isKeyRelease(data)) return;
		const cancel = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
		if (this.work) {
			if (this.work.cancel && (cancel || matchesKey(data, Key.enter))) this.work.controller.abort();
			else if (cancel) this.close();
			return;
		}
		if (cancel) return this.back();
		const frame = this.frame();
		const panel = frame.panel;
		if (panel.kind === "input") {
			if (matchesKey(data, panel.multiple ? Key.ctrl("g") : Key.enter)) panel.accept(panel.editor.getExpandedText());
			else if (unsafeInput(data)) return this.tell("Input contains unsupported control characters.");
			else panel.editor.handleInput(matchesKey(data, Key.enter) ? "\n" : data);
		} else if (panel.kind === "text") {
			if (matchesKey(data, Key.enter)) panel.copy?.();
			else panel.top = clamp(panel.top + movement(data, this.textPage), this.textBottom);
		} else {
			const { items } = this.menu(panel);
			const index = itemIndex(frame, items);
			if (matchesKey(data, Key.enter)) items[index]?.run();
			else if (items.length) {
				frame.index = clamp(index + movement(data, 6), items.length - 1);
				frame.id = items[frame.index]?.id;
			}
		}
		this.tui.requestRender();
	}

	render(width: number) {
		const available = Math.max(1, this.tui.terminal.rows - 2);
		const panel = this.frame().panel;
		const lines = panel.kind === "input" ? this.renderInput(panel, width, available) : panel.kind === "text"
			? this.renderText(panel, width, available) : this.renderMenu(this.menu(panel), width, available);
		return lines.map((line) => truncateToWidth(line, width));
	}

	dispose() {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.pollTimer);
		this.parent.removeEventListener("abort", this.close);
		this.work?.controller.abort();
		this.playback?.controller.abort();
	}

	async finish() {
		this.dispose();
		await Promise.allSettled([this.work?.done, this.playback?.done]);
	}

	private close = () => { if (!this.closed) { this.dispose(); this.done(); } };
	private frame() { return this.frames.at(-1)!; }
	private editor() { const panel = this.frame().panel; return panel.kind === "input" ? panel.editor : undefined; }
	private tell(notice: string) { this.notice = notice; if (!this.closed) this.tui.requestRender(); }

	private push(panel: Panel) {
		this.frames.push({ panel, index: 0 });
		this.tell("");
	}

	private back() {
		if (this.frames.length === 1) return this.close();
		if (this.frames.pop()?.panel.kind === "take") this.playback?.controller.abort();
		this.tell("");
	}

	private run(label: string, failure: string, task: (signal: Signal) => Promise<void>, cancel?: string) {
		if (this.closed || this.work) return;
		const work: Work = { label, cancel, controller: new AbortController() };
		const signal = AbortSignal.any([this.parent, work.controller.signal]);
		this.work = work;
		this.tell("");
		work.done = Promise.resolve().then(() => task(signal)).catch(() => {
			if (!this.closed) this.tell(signal.aborted ? "Canceled." : failure);
		}).finally(() => {
			this.work = undefined;
			if (!this.closed) this.tui.requestRender();
		});
	}

	private async open(signal: Signal) {
		this.enabled = this.api.enabled();
		if (this.enabled) await this.refresh(signal);
	}

	private poll = () => {
		if (!this.polling && this.enabled && (this.work?.cancel || (!this.work && (this.importsPending || this.rows.some(activeJob))))) {
			this.polling = true;
			void this.refresh(this.parent).finally(() => { this.polling = false; });
		}
	};

	private async refresh(signal: Signal, direction = 0) {
		const turn = ++this.refreshing;
		const cursors = [...this.cursors];
		if (direction < 0) cursors.pop();
		if (direction > 0) cursors.push(this.rows.at(-1)!.id);
		try {
			signal.throwIfAborted();
			let rows = await this.api.page(cursors.at(-1)!);
			if (direction > 0 && rows.length === 0) {
				if (!this.closed && !signal.aborted && turn === this.refreshing) this.tell("No older takes.");
				return;
			}
			while (!this.closed && !signal.aborted && cursors.length > 1 && rows.length === 0) {
				cursors.pop();
				rows = await this.api.page(cursors.at(-1)!);
			}
			if (this.closed || signal.aborted || turn !== this.refreshing) return;
			const root = this.frames[0]!;
			if (direction || cursors.length !== this.cursors.length) { root.index = 0; root.id = undefined; }
			this.cursors.splice(0, this.cursors.length, ...cursors);
			this.rows = rows;
			this.readFailed = false;
			if (root.id && !rows.some((row) => row.id === root.id)) root.id = undefined;
			const detail = this.frames[1]?.panel;
			const viewed = detail?.kind === "take" ? rows.find(({ id }) => detail.id === id) : undefined;
			if (viewed?.wav && (this.audio?.id !== viewed.id || this.audio.hash !== viewed.wav.sha256)) {
				await this.checkAudio(viewed, signal).catch(() => undefined);
			}
			if (!this.closed) this.tui.requestRender();
		} catch {
			if (this.closed || signal.aborted || turn !== this.refreshing) return;
			this.readFailed = true;
			this.tell(LIBRARY_ERROR);
		}
	}

	private menu(panel: Exclude<Panel, { kind: "text" | "input" }>): Menu {
		if (panel.kind === "menu") return panel.menu;
		if (panel.kind === "take") {
			const row = this.rows.find(({ id }) => id === panel.id);
			return row ? this.takeMenu(row) : { title: "Take no longer available", items: [] };
		}
		const title = this.action === "history" ? "Micme history" : "Micme import";
		if (this.enabled === undefined) return { title, items: [] };
		if (!this.enabled) return { title, body: "Local history is off. No library data is opened or saved.", items: [
			{ label: "Enable local history…", run: () => this.confirmHistory(true) },
		] };
		if (this.readFailed) return { title, body: this.notice === LIBRARY_ERROR ? undefined : LIBRARY_ERROR, items: [{ label: "Refresh library", run: () => this.changePage(0) }] };
		const items: Item[] = this.rows.map((row) => ({ label: listLabel(row), id: row.id, run: () => this.openTake(row) }));
		if (this.cursors.length > 1) items.push({ label: "Newer takes", run: () => this.changePage(-1) });
		if (this.rows.length === LIBRARY_PAGE_SIZE) items.push({ label: "Older takes", run: () => this.changePage(1) });
		if (this.action === "import") items.unshift({ label: "Add files…", run: () => this.enterPaths() });
		items.push({ label: "Retention…", run: () => this.retention() }, { label: "Turn off history…", run: () => this.confirmHistory(false) });
		return { title: `${title} · Page ${this.cursors.length}`, body: !this.rows.length && !this.work ? "No saved takes on this page." : undefined, items };
	}

	private changePage(direction: number) {
		this.run("Loading page…", LIBRARY_ERROR, (signal) => this.refresh(signal, direction));
	}

	private confirmHistory(enable: boolean) {
		this.confirm(enable ? "Enable local history?" : "Turn off local history?", enable
			? "Save text and verified audio together in Pi’s private local library. Not encrypted by Micme. Session replay works without history."
			: "Stop saving new takes and applying retention. Existing takes are kept, but not browsable while history is off.",
		enable ? "Enable history" : "Turn off history", () => this.run("Saving setting…", "Storage error. Could not save the history setting.", this.setHistory.bind(this, enable)));
	}

	private async setHistory(enable: boolean, signal: Signal) {
		await this.api.setEnabled(enable, signal);
		signal.throwIfAborted();
		this.enabled = this.api.enabled();
		this.rows = [];
		this.cursors.splice(1);
		this.frames[0]!.index = 0;
		this.frames[0]!.id = undefined;
		this.readFailed = false;
		if (this.enabled) await this.refresh(signal);
		if (!this.closed) {
			this.back();
			if (!this.readFailed) this.tell(this.enabled === enable ? `Local history ${enable ? "enabled" : "turned off"}.` : "A shell override still controls MICME_HISTORY.");
		}
	}

	private async checkAudio(row: Row, signal: Signal) {
		if (!row.wav) return false;
		const available = Boolean(await this.api.verifiedAudio(row.id, signal));
		const panel = this.frames[1]?.panel;
		if (!this.closed && !signal.aborted && panel?.kind === "take" && panel.id === row.id) this.audio = { id: row.id, hash: row.wav.sha256, available };
		return available;
	}

	private openTake(row: Row) {
		const root = this.frame();
		root.id = row.id;
		this.audio = undefined;
		this.push({ kind: "take", id: row.id });
		if (row.wav) this.run("Checking saved audio…", "Storage error. Could not verify saved audio.", async (signal) => { await this.checkAudio(row, signal); });
	}

	private takeMenu(row: Row): Menu {
		const hasAudio = Boolean(row.wav && this.audio?.id === row.id && this.audio.hash === row.wav.sha256 && this.audio.available);
		const text = transcriptItems(row, this.openText.bind(this));
		const items: Item[] = [...text];
		if (this.playback) items.unshift({ label: "Stop playback", run: () => this.stopPlayback() }, { label: "Seek…", run: () => this.seek(row) });
		else if (hasAudio) items.push({ label: "Play saved audio", run: () => this.startPlayback(row, 0) }, { label: "Seek…", run: () => this.seek(row) });
		if (activeJob(row)) {
			if (row.source === "import") items.push({ label: "Cancel file job", run: () => this.cancelImport(row.id) });
		} else if (!this.playback) {
			if (hasAudio) items.push({ label: "Retry with current model…", run: () => this.confirmRetry(row) });
			else if (row.source === "import" && row.state !== "ready") items.push({ label: "Reselect source file…", run: () => this.enterPaths(row) });
			items.push({ label: row.starred ? "Unstar take" : "Star take", run: () => this.toggleStar(row) });
			items.push({ label: "Delete take…", run: () => this.deleteTake(row) });
		}
		if (row.filename || row.modelId) items.push({ label: "File / model details", run: () => this.push({ kind: "text", top: 0, title: "Take details", text: [row.filename && `File: ${row.filename}`, row.modelId && `Model: ${row.modelId}`].filter(Boolean).join("\n") }) });
		const body = [
			`${row.createdUtc.slice(0, 16).replace("T", " ")} UTC · ${row.language ?? "Language unknown"}`,
			hasAudio ? "Verified saved audio" : activeJob(row) && !row.wav ? "No complete saved audio yet" : "No verified saved audio",
			row.state === "delivery-failed" && text.length ? "Saved text is still copyable." : undefined,
			row.source === "import" && !hasAudio && !activeJob(row) && row.state !== "ready" ? "Retry needs the original file again." : undefined,
			row.starred ? "Starred · protected from retention" : undefined,
			this.playback ? `Playback requested from ${this.playback.fromMs / 1000}s` : undefined,
			progress(row),
		].filter(Boolean).join("\n");
		return { title: `${row.source} · ${ROW_STATE[row.state]}`, body, items };
	}

	private openText(label: string, text: string) {
		this.push({ kind: "text", title: `${label} transcript`, text, top: 0, copy: () => this.copyText(text) });
	}

	private copyText(text: string) {
		this.run("Requesting clipboard copy…", "Clipboard unavailable. Select the text in your terminal to copy it manually.", async (signal) => {
			signal.throwIfAborted();
			await this.api.copy(text);
			if (!signal.aborted && !this.closed) this.tell("Copy requested. If blocked by your terminal, select and copy manually.");
		});
	}

	private seek(row: Row) {
		this.input("Seek saved audio", "Start at seconds (e.g. 12.5).", false, (text) => {
			const seconds = text.trim();
			const ms = Number(seconds) * 1000;
			if (!/^\d+(?:\.\d{1,3})?$/.test(seconds) || ms > Number.MAX_SAFE_INTEGER) return this.tell("Enter a nonnegative time in seconds.");
			this.back();
			this.startPlayback(row, ms);
		});
	}

	private startPlayback(row: Row, fromMs: number) {
		this.run("Preparing playback…", "Could not start playback. Check FFplay and local audio output.", async (signal) => {
			const previous = this.playback;
			previous?.controller.abort();
			await previous?.done;
			signal.throwIfAborted();
			const controller = new AbortController();
			const playSignal = AbortSignal.any([controller.signal, this.parent]);
			const playback = { fromMs, controller, done: this.play(row, fromMs, playSignal) };
			this.playback = playback;
			void playback.done.finally(() => {
				if (this.playback === playback) this.playback = undefined;
				if (!this.closed) this.tui.requestRender();
			});
		});
	}

	private async play(row: Row, fromMs: number, signal: Signal) {
		try {
			await this.api.play(row.id, fromMs, signal);
			if (!signal.aborted && !this.closed) this.tell("Playback finished.");
		} catch {
			if (signal.aborted || this.closed) return;
			this.audio = undefined;
			const available = await this.checkAudio(row, signal).catch(() => false);
			if (!signal.aborted && !this.closed) this.tell(available ? "Playback failed. Check FFplay and your audio output." : "Playback failed. Saved audio could not be verified.");
		}
	}

	private stopPlayback() {
		const playback = this.playback;
		if (!playback) return;
		this.run("Stopping playback…", "Could not stop playback.", async () => {
			playback.controller.abort();
			await playback.done;
			if (!this.closed) this.tell("Playback stopped.");
		});
	}

	private confirmRetry(row: Row) {
		this.run("Finding current installed model…", "No supported current model. Select an installed model in /micme setup.", async (signal) => {
			const model = await this.api.currentModel(signal);
			signal.throwIfAborted();
			this.confirm("Retry saved audio?", `Current model: ${modelLabel(model)}. Only a successful retry replaces saved text. Nothing is inserted or sent.`, "Start retry", () => {
				this.back();
				this.run("Retrying saved audio…", "Retry failed. Existing text was kept. Check the model or saved audio.", this.retry.bind(this, row, model), "Cancel retry");
			});
		});
	}

	private async retry(row: Row, model: Choice, signal: Signal) {
		try {
			await this.api.retry(row.id, model, signal);
			if (!this.closed && !signal.aborted) this.tell("Retry saved to the library.");
		} finally {
			if (!this.closed && !this.parent.aborted) {
				await this.refresh(this.parent);
				if (!signal.aborted) await this.checkAudio(row, signal).catch(() => { this.audio = undefined; });
			}
		}
	}

	private toggleStar(row: Row) {
		if (row.starred) this.confirm("Unstar take?", "An active retention limit can immediately remove this take and its saved audio after unstar.", "Unstar take", this.saveStar.bind(this, row));
		else this.saveStar(row);
	}

	private saveStar(row: Row) {
		this.run("Saving star…", "Storage error. Could not update the star.", async (signal) => {
			await this.api.star(row.id, !row.starred, signal);
			signal.throwIfAborted();
			if (row.starred) this.back();
			await this.refresh(signal);
			if (!this.rows.some(({ id }) => id === row.id)) this.back();
			if (!this.closed) this.tell(row.starred ? "Take unstarred." : "Take starred.");
		});
	}

	private deleteTake(row: Row) {
		this.confirm("Delete this take?", `${row.filename ?? `${row.source} from ${row.createdUtc}`}\nPermanently remove its library row and saved WAV, if present. Original import files are not changed.`, "Delete take", () => {
			this.run("Deleting take…", "Storage error. Could not delete this take safely.", async (signal) => {
				await this.api.deleteRow(row.id, signal);
				signal.throwIfAborted();
				await this.refresh(signal);
				if (!this.closed) { this.back(); this.back(); this.tell("Take deleted."); }
			});
		});
	}

	private retention() {
		const proposed = this.api.proposedRetention();
		const policy = proposed.kind === "count" ? `count:${proposed.count}` : proposed.kind === "days" ? `days:${proposed.days}` : "never";
		this.push({ kind: "menu", menu: { title: "Retention", body: "Stars and imports are protected. A confirmed policy applies to future saves, unstars and enabled restarts.", items: [
			{ label: `Preview configured policy (${policy})`, run: () => this.preview(policy) },
			{ label: "Keep all (never prune)", run: () => this.preview("never") },
			{ label: "Keep newest N dictations…", run: () => this.input("Keep newest dictations", "Enter a count (0 keeps none of the eligible takes).", false, this.previewCount.bind(this)) },
			...RETENTION_DAYS.map((days) => ({ label: `Expire after ${days} days`, run: () => this.preview(`days:${days}`) })),
		] } });
	}

	private previewCount(text: string) {
		const policy = `count:${text.trim()}`;
		try { parseRetentionPolicy(policy); }
		catch { this.tell("Enter a whole, nonnegative count."); return; }
		this.back();
		this.preview(policy);
	}

	private preview(policy: string) {
		this.run("Checking affected takes…", "Storage error. Could not preview retention safely.", async (signal) => {
			const preview = await this.api.previewPrune(policy);
			signal.throwIfAborted();
			const viewIds = { label: "View affected take IDs", run: () => this.push({ kind: "text", title: "Affected take IDs", text: preview.ids.join("\n"), top: 0 }) };
			this.confirm(`Apply retention: ${preview.policy}?`, `Delete ${preview.ids.length} take(s) and ${preview.bytes} bytes of saved WAV. The confirmed limit also applies after this preview.`, "Apply retention", () => {
				this.back();
				this.run("Applying confirmed policy…", "Could not apply retention. Refresh the preview and check local storage.", async (applySignal) => {
					await this.api.applyPrune(preview, applySignal);
					applySignal.throwIfAborted();
					await this.refresh(applySignal);
					if (!this.closed) { this.back(); this.tell(`Retention applied: ${preview.policy}.`); }
				});
			}, preview.ids.length ? viewIds : undefined);
		});
	}

	private enterPaths(reselection?: Row) {
		this.input(reselection ? "Reselect original media" : "Add local media", reselection ? `Select the original for ${reselection.filename ?? "this job"}. It starts a new job.`
			: "One literal path per line. Spaces are kept. Relative paths use Pi’s working directory.", !reselection, (input) => {
			let files: string[];
			try { files = literalPaths(this.cwd, input); }
			catch { this.tell("Use literal local file paths, not URLs."); return; }
			if (!files.length || (reselection && files.length !== 1)) return this.tell(reselection ? "Enter one local path." : "Enter at least one local path.");
			this.chooseImportModel(files);
		});
	}

	private chooseImportModel(files: readonly string[]) {
		this.run("Finding installed models…", "Could not list installed models. Check /micme setup.", async (signal) => {
			const models = await this.api.listInstalled();
			signal.throwIfAborted();
			if (!models.length) return this.tell("No installed models. Choose one in /micme setup first.");
			this.push({ kind: "menu", menu: { title: "Choose installed model", body: "The selected model is fixed for each file. No download, insertion or send.", items: models.map((model) => ({
				label: modelLabel(model), run: () => this.confirmImport(files, model),
			})) } });
		});
	}

	private confirmImport(files: readonly string[], model: Choice) {
		const details = { label: "Review files and model", run: () => this.push({ kind: "text", title: "Files and fixed model", top: 0,
			text: `Model: ${model.variantId}\n${model.language} · ${model.task} · ${model.compute}\n\n${files.join("\n")}` }) };
		this.confirm("Queue local files?", `${files.length} file(s) · ${modelLabel(model)}. Original files are unchanged.`, "Queue files", () => {
			this.run("Queuing files…", "Could not start local import. Check history storage and the local media service.", async (signal) => {
				const imports = await this.api.localImport();
				signal.throwIfAborted();
				// Accepted file jobs belong to the service, not to keyboard focus.
				const pending = imports.files(files, model, this.parent);
				this.importsPending += 1;
				this.frames.splice(1);
				this.cursors.splice(1);
				this.frames[0]!.index = 0;
				this.frames[0]!.id = undefined;
				this.tell("Import handed to the local job service.");
				void pending.then((ids) => this.importResult(ids.length), () => this.importResult(null));
				await this.refresh(signal);
			});
		}, details);
	}

	private async importResult(count: number | null) {
		this.importsPending -= 1;
		if (this.closed || this.parent.aborted) return;
		await this.refresh(this.parent);
		if (!this.closed && !this.parent.aborted) this.tell(count === null ? "Import reported an error. Check per-file states." : `Jobs accepted: ${count}. See each file for status.`);
	}

	private cancelImport(id: EntryId) {
		this.run("Requesting cancellation…", "Could not cancel this file job.", async (signal) => {
			const imports = await this.api.localImport();
			signal.throwIfAborted();
			imports.cancel(id);
			await this.refresh(signal);
			if (!this.closed) this.tell("File job cancellation requested.");
		});
	}

	private confirm(title: string, body: string, confirm: string, run: () => void, inspect?: Item) {
		this.push({ kind: "menu", menu: { title, body, items: [{ label: "Cancel", run: this.back.bind(this) }, ...(inspect ? [inspect] : []), { label: confirm, run }] } });
	}

	private input(title: string, prompt: string, multiple: boolean, accept: (text: string) => void) {
		const border = this.theme.fg.bind(this.theme, "borderMuted");
		const accent = this.theme.fg.bind(this.theme, "accent");
		const muted = this.theme.fg.bind(this.theme, "muted");
		const editor = new Editor(this.tui, { borderColor: border, selectList: { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted } });
		editor.disableSubmit = true;
		editor.focused = true;
		this.push({ kind: "input", title, prompt, editor, multiple, accept });
	}

	private renderMenu(menu: Menu, width: number, available: number) {
		const frame = this.frame();
		const body = wrapTextWithAnsi(displayText(menu.body ?? ""), width).filter(Boolean);
		const hint = this.work?.cancel ? `Enter/Esc: ${this.work.cancel}` : NAVIGATION;
		const items = this.work ? this.work.cancel ? [{ label: this.work.cancel, run: this.work.controller.abort.bind(this.work.controller) }] : [] : menu.items;
		const index = this.work ? 0 : itemIndex(frame, items);
		const head = this.header(menu.title, width, available, hint);
		const room = Math.max(1, available - head.length - 1);
		const info = body.slice(0, Math.min(7, Math.max(0, room - 1)));
		const limit = Math.max(1, room - info.length);
		const start = Math.max(0, Math.min(index - Math.floor(limit / 2), items.length - limit));
		const visible = items.slice(start, start + limit).map(({ label }, offset) => {
			const selected = start + offset === index;
			const text = `${selected ? "→" : " "} ${displayText(label)}`;
			return selected ? this.theme.fg("accent", text) : text;
		});
		const suffix = items.length > limit ? ` · ${index + 1}/${items.length}` : "";
		return [...head, ...info, ...visible, this.theme.fg("dim", `${hint}${suffix}`)];
	}

	private renderText(panel: Extract<Panel, { kind: "text" }>, width: number, available: number) {
		const hint = panel.copy ? "↑↓ scroll · Enter Copy · Esc back" : "↑↓ scroll · Esc back";
		const head = this.header(panel.title, width, available, hint);
		if (panel.wrapped?.width !== width) panel.wrapped = { width, lines: wrapTextWithAnsi(displayText(panel.text), width) };
		const { lines } = panel.wrapped;
		this.textPage = Math.max(1, available - head.length - 1);
		this.textBottom = Math.max(0, lines.length - this.textPage);
		panel.top = clamp(panel.top, this.textBottom);
		return [...head, ...lines.slice(panel.top, panel.top + this.textPage), this.theme.fg("dim", hint)];
	}

	private renderInput(panel: Extract<Panel, { kind: "input" }>, width: number, available: number) {
		const hint = panel.multiple ? "Enter new line · Ctrl+G next · Esc" : "Enter next · Esc back";
		const head = this.header(panel.title, width, available, hint);
		const prompt = wrapTextWithAnsi(displayText(panel.prompt), width).slice(0, Math.max(0, available - head.length - 5));
		const lines = panel.editor.render(width);
		const room = Math.max(1, available - head.length - prompt.length - 1);
		return [...head, ...prompt, ...lines.slice(0, room), this.theme.fg("dim", hint)];
	}

	private header(title: string, width: number, available: number, hint: string) {
		const status = this.work?.label || this.notice;
		// Keep the back/close affordance reachable even on a tiny terminal.
		if (available < 4) return [this.theme.fg("accent", `${displayText(title)} · Esc back`)];
		return [this.theme.fg("accent", displayText(title)), ...(status ? wrapTextWithAnsi(status, width).slice(0, Math.min(3, available - 3)) : []),
			...(width < 24 ? [this.theme.fg("dim", hint.includes("Esc") ? "Esc back" : hint)] : [])];
	}
}

function clamp(value: number, max: number) { return Math.max(0, Math.min(max, value)); }

function movement(data: string, page: number) {
	if (matchesKey(data, Key.up)) return -1;
	if (matchesKey(data, Key.down)) return 1;
	if (matchesKey(data, Key.pageUp)) return -page;
	if (matchesKey(data, Key.pageDown)) return page;
	return 0;
}

function itemIndex(frame: Frame, items: Item[]) {
	const byId = frame.id ? items.findIndex(({ id }) => id === frame.id) : -1;
	return byId >= 0 ? byId : clamp(frame.index, items.length - 1);
}

function displayText(text: string) {
	return stripTerminalControlSequences(text.replace(/\p{Bidi_Control}/gu, "")).replaceAll("\t", "    ");
}

function activeJob(row: Row) { return row.state === "queued" || row.state === "decoding" || row.state === "recognizing"; }

function listLabel(row: Row) {
	const date = row.createdUtc.slice(5, 16).replace("T", " ");
	return `${row.starred ? "★ " : ""}${row.source} · ${ROW_STATE[row.state]} · ${row.filename ?? date}`.replace(/[\r\n]/g, " ");
}

function progress(row: Row) {
	if (row.state !== "recognizing") return undefined;
	return row.totalSamples === null ? `${row.doneSamples} samples processed` : `${row.doneSamples}/${row.totalSamples} samples processed`;
}

function transcriptItems(row: Row, show: (label: string, text: string) => void): Item[] {
	return TRANSCRIPTS.flatMap(([key, label]) => {
		const text = row[key];
		return text ? [{ label: `${label} transcript`, run: () => show(label, text) }] : [];
	});
}

function modelLabel(model: Choice) {
	const id = model.variantId;
	if (isAbsolute(id)) return basename(id).replace(/[\r\n]/g, " ");
	const [name, revision] = id.split("@");
	const label = name!.split("/").slice(-2).join("/");
	return (revision ? `${label} · ${revision.slice(0, 7)}` : label).replace(/[\r\n]/g, " ");
}

function unsafeInput(data: string) {
	if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
		return UNSAFE_INPUT.test(data.slice(PASTE_START.length, -PASTE_END.length).replaceAll("\r\n", "\n"));
	}
	const printable = decodeKittyPrintable(data) ?? data;
	return /[\u007f-\u009f]|\p{Bidi_Control}/u.test(printable) && printable !== "\x7f";
}

function literalPaths(cwd: string, input: string) {
	return input.split(/\r?\n/).filter((line) => line.length > 0).map((line) => {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) || UNSAFE_INPUT.test(line)) throw new Error("Not a local path");
		return isAbsolute(line) ? line : `${cwd}${sep}${line}`;
	});
}
