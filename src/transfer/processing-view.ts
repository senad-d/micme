import type { TUI } from "@earendil-works/pi-tui";
import { getTransferOptions } from "../config.ts";
import { stripTerminalControlSequences } from "../terminal-text.ts";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "../terminal-ui.ts";
import { DEFAULT_POLISH_PROMPT, type Ctx, type Host, type ProcessingAction, type Selection, type ShowProcessing, type Signal, type TransferOptions } from "./contracts.ts";
import { showProcessingWarnings } from "./host.ts";
import { processFinal } from "./process-final.ts";

type SavedLive = NonNullable<ReturnType<Host["lastLive"]>>;
type Route = { label: string; details: string[]; selection: Selection };

export const showProcessing: ShowProcessing = async (ctx, host, action, signal) => {
	if (signal.aborted) return;
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`/micme ${action} requires interactive TUI mode.`, "warning");
		return;
	}
	const saved = action === "preview" ? host.lastLive() : null;
	if (action === "preview" && (saved?.final.source !== "live" || !saved.final.local.trim())) {
		ctx.ui.notify("No saved live final to preview. Finish a live take first.", "info");
		return;
	}
	const routes = processingRoutes(getTransferOptions());
	if (!routes.length) {
		ctx.ui.notify("Micme processing is not configured. Set a provider, endpoint and model (plus a key variable name if required), or configure MICME_OUTPUT_HOOK.", "warning");
		return;
	}

	const dismissed = new AbortController();
	const previewSignal = AbortSignal.any([signal, dismissed.signal]);
	let pending: Promise<void> | undefined;
	try {
		// An inline Pi dialog restores the editor by setting its text. Use a
		// capturing overlay so neither the draft nor its cursor is replaced.
		const selection = await ctx.ui.custom<Selection | undefined>((tui, theme, _keys, done) => new ProcessingPanel({
			tui, theme, action, routes, signal: previewSignal,
			done: (choice) => {
				if (!choice) dismissed.abort();
				done(choice);
			},
			confirm: (choice, panel) => {
				if (saved) {
					panel.showPending();
					pending = reviewCandidate(ctx, saved, choice, previewSignal, panel);
				} else panel.close(choice);
			},
		}), { overlay: true, overlayOptions: { width: "96%" } });
		if (selection && !signal.aborted) await host.startProcessedClip(selection);
	} finally {
		dismissed.abort();
		await pending;
	}
};

function processingRoutes(options: TransferOptions): Route[] {
	const polish = configuredPolish(options);
	const hook = options.MICME_OUTPUT_HOOK;
	const routes: Route[] = [];
	if (polish && hook) routes.push({ label: "Polish + hook", details: describePolish(polish), selection: { ...polish, hook } });
	if (polish) routes.push({ label: "Polish only", details: describePolish(polish), selection: polish });
	if (hook) routes.push({ label: "Hook only", details: ["No provider request. The local final transcript goes to the configured executable."],
		selection: { provider: null, endpoint: null, model: "", prompt: "", keyEnv: null, hook } });
	return routes;
}

function configuredPolish(options: TransferOptions): Selection | null {
	const { MICME_POLISH_PROVIDER: provider, MICME_POLISH_ENDPOINT: endpoint, MICME_POLISH_MODEL: model,
		MICME_POLISH_PROMPT: prompt, MICME_POLISH_KEY_ENV: keyEnv } = options;
	if (!provider) return null;
	if (provider === "apple-device") {
		if (endpoint || keyEnv || (model && model !== "system")) return null;
	} else if (!endpoint || !model || (needsKey(provider) && !keyEnv)) {
		return null;
	}
	// The provider service still validates the exact model/base/auth cohort
	// before dispatch. A configured choice is not a qualification result.
	return { provider, endpoint, model, prompt: prompt.trim() ? prompt : DEFAULT_POLISH_PROMPT, keyEnv, hook: null };
}

function needsKey(provider: Selection["provider"]) {
	return provider !== null && provider !== "local-openai" && provider !== "custom-openai" && provider !== "custom-anthropic" && provider !== "apple-device";
}

function describePolish({ provider, endpoint, model, prompt, keyEnv }: Selection): string[] {
	if (!endpoint) return ["Destination: Apple on-device model. No provider network request.",
		"Model: system · Credential: none", `Prompt: ${displayText(prompt)}`];
	const api = provider === "anthropic" || provider === "custom-anthropic" ? "messages" : "chat/completions";
	const source = needsKey(provider) ? "Required credential" : "Credential";
	return [`Provider: ${provider}`, `Destination: ${endpoint.href.replace(/\/+$/, "")}/${api}`,
		"Sends final transcript text, model and prompt; no audio or drafts.",
		"Cancel cannot recall text already sent.", `Model: ${displayText(model)}`,
		`${source}: ${keyEnv ? `from ${keyEnv} (sent only to this destination)` : "none"}`, `Prompt: ${displayText(prompt)}`];
}

async function reviewCandidate(ctx: Ctx, saved: SavedLive, selection: Selection, signal: Signal, panel: ProcessingPanel) {
	try {
		const output = await processFinal(saved.final, { mode: "live-preview", row: saved.row }, selection, signal);
		if (signal.aborted || (output.kind === "suppressed" && output.reason === "cancel")) return panel.close();
		showProcessingWarnings(ctx, output.warnings);
		const text = output.kind === "candidate" ? displayText(output.text) : "";
		if (text.trim()) {
			panel.showCandidate(text);
		} else {
			ctx.ui.notify("Micme output was empty. No preview was produced; /micme last is unchanged.", "info");
			panel.close();
		}
	} catch {
		if (!signal.aborted) ctx.ui.notify("Micme could not preview this final. Use /micme last for the original transcript.", "warning");
		panel.close();
	}
}

function displayText(text: string) {
	return stripTerminalControlSequences(text.replace(/\p{Bidi_Control}/gu, "")).replaceAll("\t", "    ");
}

type PanelOptions = {
	tui: TUI;
	theme: Ctx["ui"]["theme"];
	action: ProcessingAction;
	routes: Route[];
	signal: Signal;
	done: (selection?: Selection) => void;
	confirm: (selection: Selection, panel: ProcessingPanel) => void;
};

class ProcessingPanel implements Component {
	private readonly options: PanelOptions;
	private phase: "consent" | "pending" | "candidate" = "consent";
	private candidate = "";
	private route = 0;
	private top = 0;
	private lastPage = 0;
	private pageSize = 1;
	private rendered = false;
	private closed = false;

	constructor(options: PanelOptions) {
		this.options = options;
		if (options.signal.aborted) this.close();
		else options.signal.addEventListener("abort", this.onAbort, { once: true });
	}

	private readonly onAbort = () => this.close();

	close(selection?: Selection) {
		if (this.closed) return;
		this.closed = true;
		this.options.signal.removeEventListener("abort", this.onAbort);
		this.options.done(selection);
	}

	dispose() { this.close(); }

	showPending() {
		this.phase = "pending";
		this.top = 0;
		this.options.tui.requestRender();
	}

	showCandidate(text: string) {
		this.phase = "candidate";
		this.candidate = text;
		this.top = 0;
		this.options.tui.requestRender();
	}

	invalidate() { /* Render from the current terminal dimensions. */ }

	handleInput(data: string) {
		const { signal, confirm, routes, tui } = this.options;
		if (this.closed || signal.aborted) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return this.close();
		if (this.phase === "pending") return;
		if (matchesKey(data, Key.enter)) {
			if (this.phase === "candidate") return this.close();
			if (!this.rendered) return;
			if (this.top >= this.lastPage) return confirm(routes[this.route].selection, this);
			this.top = Math.min(this.lastPage, this.top + this.pageSize);
		} else if (matchesKey(data, Key.up)) {
			this.top = Math.max(0, this.top - 1);
		} else if (matchesKey(data, Key.down)) {
			this.top = Math.min(this.lastPage, this.top + 1);
		} else if (this.phase === "consent" && routes.length > 1 && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
			this.route = (this.route + (matchesKey(data, Key.right) ? 1 : routes.length - 1)) % routes.length;
			this.top = 0;
		} else return;
		this.rendered = false;
		tui.requestRender();
	}

	render(width: number) {
		const { tui, routes, theme } = this.options;
		const [title, text] = this.content();
		const body = wrapTextWithAnsi(text, width);
		this.pageSize = Math.max(1, tui.terminal.rows - 5);
		this.lastPage = Math.max(0, body.length - this.pageSize);
		this.top = Math.min(this.top, this.lastPage);
		this.rendered = true;
		const scroll = this.lastPage ? "↑↓ scroll" : "";
		const route = this.phase === "consent" && routes.length > 1 ? "←→ route" : "";
		const navigation = [route, scroll].filter(Boolean).join(" · ");
		const escape = width < 28 ? "Esc" : "Esc cancel";
		const keys = this.phase === "consent" ? `${escape} · Enter ${this.top < this.lastPage ? "more" : "confirm"}`
			: this.phase === "candidate" ? "Esc / Enter close" : escape;
		return [theme.fg("accent", truncateToWidth(title, width)),
			...body.slice(this.top, this.top + this.pageSize).map((line) => truncateToWidth(line, width)),
			theme.fg("dim", truncateToWidth(keys, width)),
			...(navigation ? [theme.fg("dim", truncateToWidth(navigation, width))] : [])];
	}

	private content(): [string, string] {
		if (this.phase === "pending") return ["Micme preview", "Processing saved live final…"];
		if (this.phase === "candidate") return ["Micme preview · Read only", `Select text to copy. The prompt is unchanged.\n\n${this.candidate}`];
		const { action, routes } = this.options;
		const { label, details, selection: { hook } } = routes[this.route];
		const next = action === "polish" ? "Arm one clip. Use your usual toggle to stop recording." : "Preview the saved live final without changing the prompt or replay.";
		return [action === "polish" ? "Micme polish · New clip" : "Micme preview · Saved live final",
			[`› ${label}${routes.length > 1 ? ` (${this.route + 1}/${routes.length})` : ""}`, next, ...details,
				...(hook ? [`Trusted hook: ${displayText(hook)}`, "The hook receives pre-hook text on stdin and controls its own behavior."] : [])].join("\n")];
	}
}
