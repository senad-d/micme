import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import {
	env,
	envFlag,
	expandConfigPath,
	getAudioFilter,
	getAudioInputConfigKey,
	getFlagSetting,
	getAutoDownloadModel,
	getAvfoundationDropLateFrames,
	getMeterGain,
	getRecordMeter,
	getRecordSampleRate,
	getRecordSync,
	getShortcutSettingValue,
	getStreamFinalizeWithClip,
	getTranslateToEnglishLanguage,
	getTranscribeSampleRate,
	getTranscriptionMode,
	getTranscriptionModeProfile,
	reloadMicmeConfig,
	requireValidMicmeConfig,
	writeMicmeConfigValues,
} from "./config.ts";
import { discoverAudioDevices, LIVE_CAPTURE_RATE } from "./audio.ts";
import { formatBackendLabel, resolveTranscriptionPlan } from "./backends.ts";
import { discoverPythonWhisperModels, discoverWhisperCppModels, ensureWhisperCppModel, getPythonWhisperModelName, getWhisperVadModelPath, isRegularFile, resolveWhisperCppModel } from "./models.ts";
import { findExecutable } from "./processes.ts";
import { fitTerminalTail } from "./recording-widget.ts";
import { sanitizeTerminalOutput, sanitizeTerminalText } from "./terminal-text.ts";
import { decodeKittyPrintable, fuzzyFilter, matchesKey, matchesSelectionAction, parseShortcutKey, terminalDefaultShortcut, type TerminalRows, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./terminal-ui.ts";
import type { AudioDeviceCandidate, ModelCandidate, ResolvedTranscriptionPlan } from "./types.ts";

type MicmeTheme = ExtensionContext["ui"]["theme"];

type ConfigurationCategoryId = "general" | "transcription" | "streaming" | "audio";
type FocusedPane = "categories" | "settings";
type DisplayKind = "boolean" | "number" | "path" | "slider" | "text" | "model";

interface ConfigurationCategory {
	id: ConfigurationCategoryId;
	label: string;
	description: string;
}

interface ConfigurationItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[];
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => TerminalRows;
	categoryId: ConfigurationCategoryId;
	rawValue: string;
	displayKind?: DisplayKind;
	emptyLabel?: string;
	valueLabels?: Record<string, string>;
	details?: string[];
	visibleWhen?: (plan: ResolvedTranscriptionPlan) => boolean;
}

type ConfigurationView = { items: ConfigurationItem[]; plan: ResolvedTranscriptionPlan };

const CONFIGURATION_CATEGORIES: ConfigurationCategory[] = [
	{ id: "general", label: "General", description: "Core defaults used by Micme." },
	{ id: "transcription", label: "Transcription", description: "Backend model, mode, and transcription fallback settings." },
	{ id: "streaming", label: "Streaming", description: "Local decoder, speech detector, and optional final pass." },
	{ id: "audio", label: "Audio", description: "Recording, preprocessing, and metering settings." },
];

const TWO_PANE_MIN_WIDTH = 72;
const MAX_SETTINGS_ROWS = 10;
const LANGUAGE_LABELS: Record<string, string> = {
	auto: "Auto detect",
	en: "English",
	bs: "Bosnian",
	hr: "Croatian",
	sr: "Serbian",
	de: "German",
	es: "Spanish",
	fr: "French",
	it: "Italian",
	pt: "Portuguese",
	nl: "Dutch",
	pl: "Polish",
	tr: "Turkish",
};
const TRANSCRIPTION_LANGUAGE_VALUES = ["en", "auto", "bs", "hr", "sr", "de", "es", "fr", "it", "pt", "nl", "pl", "tr"];
const TRANSLATION_SOURCE_LANGUAGE_VALUES = ["bs", "hr", "sr", "de", "es", "fr", "it", "pt", "nl", "pl", "tr"];
const TRANSLATE_FROM_VALUE_LABELS: Record<string, string> = {
	off: "Off",
	...Object.fromEntries(TRANSLATION_SOURCE_LANGUAGE_VALUES.map((language) => [language, `${LANGUAGE_LABELS[language] ?? language} → English`])),
};

type ConfigurationDiscoveryKey = "audio devices" | "whisper.cpp models" | "Python Whisper models";

type ConfigurationDiscoveryState = {
	audioDevices: AudioDeviceCandidate[];
	modelCandidates: ModelCandidate[];
	pythonModelCandidates: ModelCandidate[];
	pending: Set<ConfigurationDiscoveryKey>;
};

export async function showConfiguration(ctx: ExtensionContext, sessionSignal?: AbortSignal) {
	if (sessionSignal?.aborted) return;
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/micme conf requires interactive TUI mode.", "warning");
		return;
	}

	const configState = reloadMicmeConfig();
	if (configState.error) {
		notifySanitized(ctx, `Micme config is invalid at ${configState.path}: ${configState.error}. Fix it before saving settings.`, "warning");
	}
	let discoveryWork: Promise<void> | undefined;
	let pendingSave: Promise<Record<string, string>> | undefined;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		sessionSignal?.throwIfAborted();
		const canDiscover = !configState.error;
		const discovery = createInitialConfigurationDiscovery(canDiscover);
		const controller = new AbortController();
		const closeScreen = () => screen.close();
		const screen = new ConfigurationScreen({
			configPath: sanitizeTerminalText(configState.path) || "micme.json",
			view: buildConfigurationView(discovery.modelCandidates, discovery.pythonModelCandidates, discovery.audioDevices, theme),
			theme,
			onDone: () => {
				sessionSignal?.removeEventListener("abort", closeScreen);
				controller.abort();
				done();
			},
			onError: (error) => notifySanitized(ctx, error instanceof Error ? error.message : String(error), "error"),
			onSave: (id, newValue) => {
				pendingSave = saveConfigurationValue(ctx, id, newValue, { signal: controller.signal });
				return pendingSave.then(() => buildConfigurationView(discovery.modelCandidates, discovery.pythonModelCandidates, discovery.audioDevices, theme));
			},
			readShortcut: (data) => getShortcutInput(data, ctx.ui),
			requestRender: () => tui.requestRender(),
			statusText: canDiscover ? formatDiscoveryStatus(discovery.pending) : "Fix Micme config and reopen settings to run discovery.",
		});

		sessionSignal?.addEventListener("abort", closeScreen, { once: true });
		if (canDiscover) {
			discoveryWork = startConfigurationDiscovery({ ctx, cwd: ctx.cwd, theme, discovery, screen, signal: controller.signal });
		}

		return screen;
	});
	// The dialog has closed. Let its cancelled subprocesses and save release their resources.
	await Promise.allSettled([discoveryWork, pendingSave]);
}

function createInitialConfigurationDiscovery(enabled: boolean): ConfigurationDiscoveryState {
	return {
		audioDevices: [],
		modelCandidates: [],
		pythonModelCandidates: [],
		pending: new Set(enabled ? ["audio devices", "whisper.cpp models", "Python Whisper models"] : []),
	};
}

async function startConfigurationDiscovery(options: {
	ctx: ExtensionContext;
	cwd: string;
	theme: MicmeTheme;
	discovery: ConfigurationDiscoveryState;
	screen: ConfigurationScreen;
	signal: AbortSignal;
}) {
	const { signal } = options;
	await Promise.allSettled([
		loadConfigurationDiscovery(options, "audio devices", deferDiscovery(() => discoverAudioDevices(signal), signal), (audioDevices) => {
			options.discovery.audioDevices = audioDevices;
		}),
		loadConfigurationDiscovery(options, "whisper.cpp models", deferDiscovery(() => discoverWhisperCppModels(options.cwd), signal), (modelCandidates) => {
			options.discovery.modelCandidates = modelCandidates;
		}),
		loadConfigurationDiscovery(options, "Python Whisper models", deferDiscovery(() => discoverPythonWhisperModels(signal), signal), (pythonModelCandidates) => {
			options.discovery.pythonModelCandidates = pythonModelCandidates;
		}),
	]);
}

async function loadConfigurationDiscovery<T>(
	options: {
		ctx: ExtensionContext;
		theme: MicmeTheme;
		discovery: ConfigurationDiscoveryState;
		screen: ConfigurationScreen;
		signal: AbortSignal;
	},
	key: ConfigurationDiscoveryKey,
	promise: Promise<T>,
	applyResult: (value: T) => void,
) {
	try {
		const result = await promise;
		if (!options.signal.aborted) applyResult(result);
	} catch (error) {
		if (!options.signal.aborted) notifySanitized(options.ctx, `Micme could not load ${key}: ${error instanceof Error ? error.message : String(error)}`, "warning");
	} finally {
		options.discovery.pending.delete(key);
		if (!options.signal.aborted) {
			options.screen.updateDiscoveredItems(
				buildConfigurationView(options.discovery.modelCandidates, options.discovery.pythonModelCandidates, options.discovery.audioDevices, options.theme),
				formatDiscoveryStatus(options.discovery.pending),
			);
		}
	}
}

async function deferDiscovery<T>(load: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
	await nextImmediate(undefined, { signal });
	signal.throwIfAborted();
	return load();
}

function formatDiscoveryStatus(pending: Set<ConfigurationDiscoveryKey>) {
	if (pending.size === 0) return "";
	return `Loading ${[...pending].join(", ")}…`;
}

function notifySanitized(ctx: ExtensionContext, message: string, level: "warning" | "error") {
	ctx.ui.notify(sanitizeTerminalOutput(message) || "Micme configuration message was empty.", level);
}

class ConfigurationScreen implements TerminalRows {
	private readonly configPath: string;
	private view: ConfigurationView;
	private readonly theme: MicmeTheme;
	private readonly onDone: () => void;
	private readonly onError: (error: unknown) => void;
	private readonly onSave: (id: string, newValue: string) => Promise<ConfigurationView>;
	private readonly readShortcut: (data: string) => string | null;
	private readonly requestRender: () => void;
	private focusedPane: FocusedPane = "categories";
	private categoryIndex = 0;
	private readonly selectedByCategory = new Map<ConfigurationCategoryId, number>();
	private searchActive = false;
	private searchQuery = "";
	private selectedSearchIndex = 0;
	private submenuComponent: TerminalRows | null = null;
	private editingShortcutItem: ConfigurationItem | null = null;
	private pendingShortcutValue = "";
	private saving = false;
	private statusText = "";
	private closed = false;

	constructor(options: {
		configPath: string;
		view: ConfigurationView;
		theme: MicmeTheme;
		onDone: () => void;
		onError: (error: unknown) => void;
		onSave: (id: string, newValue: string) => Promise<ConfigurationView>;
		readShortcut: (data: string) => string | null;
		requestRender: () => void;
		statusText?: string;
	}) {
		this.configPath = options.configPath;
		this.view = options.view;
		this.theme = options.theme;
		this.onDone = options.onDone;
		this.onError = options.onError;
		this.onSave = options.onSave;
		this.readShortcut = options.readShortcut;
		this.requestRender = options.requestRender;
		this.statusText = options.statusText ?? "";
		for (const category of CONFIGURATION_CATEGORIES) this.selectedByCategory.set(category.id, 0);
	}

	updateDiscoveredItems(view: ConfigurationView, statusText: string) {
		if (this.closed) return;
		this.view = view;
		this.clampSelections();
		if (!this.saving && (!this.statusText || this.statusText.startsWith("Loading "))) {
			this.statusText = statusText;
		}
		this.requestRender();
	}

	render(width: number): readonly string[] {
		if (this.submenuComponent) return this.submenuComponent.render(width);
		if (width < TWO_PANE_MIN_WIDTH) return this.renderNarrow(width);
		return this.renderTwoPane(width);
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.forwardSubmenuInput(data)) return;
		if (this.forwardShortcutCaptureInput(data)) return;
		if (this.handleCloseInput(data)) return;

		if (this.handleSearchInput(data)) {
			this.requestRender();
			return;
		}

		if (this.handlePaneSwitchInput(data)) return;
		if (this.handleSelectionMoveInput(data)) return;
		if (this.handleSettingActivationInput(data)) return;
		this.handleEscapeNavigation(data);
	}

	private forwardSubmenuInput(data: string) {
		if (!this.submenuComponent) return false;
		this.submenuComponent.handleInput?.(data);
		this.requestRender();
		return true;
	}

	private forwardShortcutCaptureInput(data: string) {
		if (!this.editingShortcutItem) return false;
		this.handleShortcutCaptureInput(data);
		return true;
	}

	private handleCloseInput(data: string) {
		const text = getPrintableInput(data);
		if (!matchesKey(data, "ctrl+c") && text !== "q" && text !== "Q") return false;
		this.close();
		return true;
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.onDone();
	}

	// OMP may unmount the rows independently of their own key handler.
	dispose() {
		this.close();
	}

	private handlePaneSwitchInput(data: string) {
		if (!matchesKey(data, "tab") && !matchesKey(data, "shift+tab")) return false;
		this.focusedPane = this.focusedPane === "categories" ? "settings" : "categories";
		this.requestRender();
		return true;
	}

	private handleSelectionMoveInput(data: string) {
		if (matchesKey(data, "up")) {
			this.moveSelection(-1);
			this.requestRender();
			return true;
		}
		if (!matchesKey(data, "down")) return false;
		this.moveSelection(1);
		this.requestRender();
		return true;
	}

	private handleSettingActivationInput(data: string) {
		if (matchesKey(data, "enter")) {
			if (this.focusedPane === "categories") {
				this.focusedPane = "settings";
			} else {
				this.activateSelectedSetting();
			}
			this.requestRender();
			return true;
		}

		if (!matchesKey(data, "space") || this.focusedPane !== "settings") return false;
		this.activateSelectedSetting();
		this.requestRender();
		return true;
	}

	private handleEscapeNavigation(data: string) {
		if (!matchesKey(data, "escape")) return;
		if (this.focusedPane === "settings") {
			this.focusedPane = "categories";
			this.requestRender();
		} else {
			this.close();
		}
	}

	private renderTwoPane(width: number): string[] {
		if (width < 24) return this.renderTiny(width);

		const leftWidth = Math.min(22, Math.max(16, Math.floor(width * 0.27)));
		const rightWidth = Math.max(10, width - leftWidth - 3);
		const categoryLines = this.renderCategoryPaneLines(leftWidth);
		const settingsLines = this.renderSettingsPaneLines(rightWidth);
		const paneHeight = Math.max(categoryLines.length, settingsLines.length, 8);
		const lines: string[] = [];

		lines.push(
			this.renderTitleBorder(width, this.currentHeaderLabel()),
			...this.renderConfigSourceLines(width),
			this.renderFullLine(width, "↑↓ move  Tab pane  Enter edit  / search  Esc back  q quit"),
			this.renderPaneSeparator(width, leftWidth, rightWidth, "top"),
		);

		for (let index = 0; index < paneHeight; index++) {
			const left = categoryLines[index] ?? "";
			const right = settingsLines[index] ?? "";
			lines.push(this.renderPaneLine(left, right, leftWidth, rightWidth));
		}

		lines.push(
			this.renderPaneSeparator(width, leftWidth, rightWidth, "bottom"),
			...this.renderFooterLines(width),
			this.colorBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`, width),
		);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderNarrow(width: number): string[] {
		if (width < 24) return this.renderTiny(width);

		const innerWidth = width - 2;
		const showCategories = this.focusedPane === "categories" && !this.hasSearchQuery();
		const bodyLines = showCategories ? this.renderCategoryPaneLines(innerWidth) : this.renderSettingsPaneLines(innerWidth);
		const navigation = showCategories ? "↑↓ category  Enter open  / search  q quit" : "↑↓ move  Enter edit  Esc back  / search  q quit";
		const lines: string[] = [];

		lines.push(
			this.renderTitleBorder(width, this.currentHeaderLabel()),
			...this.renderConfigSourceLines(width),
			...wrapTextWithAnsi(navigation, innerWidth).map((line) => this.renderFullLine(width, line)),
			this.colorBorder(`├${"─".repeat(innerWidth)}┤`, width),
		);
		for (const line of bodyLines) lines.push(this.renderFullLine(width, line));
		lines.push(
			this.colorBorder(`├${"─".repeat(innerWidth)}┤`, width),
			...this.renderFooterLines(width),
			this.colorBorder(`╰${"─".repeat(innerWidth)}╯`, width),
		);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderTiny(width: number): string[] {
		const selected = this.getSelectedSetting();
		return [
			fitAnsi("Micme Configuration", width),
			fitAnsi(this.currentHeaderLabel(), width),
			fitAnsi(selected ? `${selected.label}: ${this.formatValue(selected, Math.max(0, width - selected.label.length - 2))}` : "No settings", width),
			fitAnsi("q quit", width),
		];
	}

	private renderTitleBorder(width: number, rightLabel: string) {
		const innerWidth = Math.max(0, width - 2);
		const title = "─ Micme Configuration ";
		const right = ` ${rightLabel} ─`;
		const fillWidth = innerWidth - visibleWidth(title) - visibleWidth(right);
		let inner: string;
		if (fillWidth >= 0) {
			inner = `${title}${"─".repeat(fillWidth)}${right}`;
		} else {
			inner = padRightAnsi(fitAnsi(`─ Micme Configuration ${rightLabel}`, innerWidth), innerWidth);
		}
		return this.colorBorder(`╭${inner}╮`, width);
	}

	private renderFullLine(width: number, text: string) {
		const innerWidth = Math.max(0, width - 2);
		return `${this.theme.fg("accent", "│")}${padRightAnsi(text, innerWidth)}${this.theme.fg("accent", "│")}`;
	}

	private renderPaneSeparator(width: number, leftWidth: number, rightWidth: number, position: "top" | "bottom") {
		const middle = position === "top" ? "┬" : "┴";
		return this.colorBorder(`├${"─".repeat(leftWidth)}${middle}${"─".repeat(rightWidth)}┤`, width);
	}

	private renderPaneLine(left: string, right: string, leftWidth: number, rightWidth: number) {
		return [
			this.theme.fg("accent", "│"),
			padRightAnsi(left, leftWidth),
			this.theme.fg("accent", "│"),
			padRightAnsi(right, rightWidth),
			this.theme.fg("accent", "│"),
		].join("");
	}

	private colorBorder(line: string, width: number) {
		return this.theme.fg("accent", fitAnsi(line, width, ""));
	}

	private renderConfigSourceLines(width: number) {
		return wrapTextWithAnsi(`writes ${this.configPath} • shell env overrides Micme settings`, width - 2).map((line) => this.renderFullLine(width, line));
	}

	private renderCategoryPaneLines(width: number) {
		return CONFIGURATION_CATEGORIES.map((category, index) => {
			const selected = index === this.categoryIndex;
			const focused = this.focusedPane === "categories";
			const selectedColor = focused ? "accent" : "muted";
			const prefix = selected ? "▶ " : "  ";
			const styledPrefix = selected ? this.theme.fg(selectedColor, prefix) : prefix;
			const label = fitAnsi(category.label, Math.max(0, width - 2));
			const selectedLabel = focused ? this.theme.bold(label) : label;
			const styledLabel = selected ? this.theme.fg(selectedColor, selectedLabel) : this.theme.fg("dim", label);
			return padRightAnsi(`${styledPrefix}${styledLabel}`, width);
		});
	}

	private renderSettingsPaneLines(width: number) {
		const displayItems = this.getDisplaySettings();
		const selectedIndex = this.getSelectedSettingIndex(displayItems.length);
		const scope = this.getSettingsScopeTitle();
		const titleColor = this.focusedPane === "settings" ? "accent" : "dim";
		const title = this.theme.fg(titleColor, this.theme.bold(fitAnsi(scope, Math.max(0, width - 8))));
		const counter = displayItems.length > 0 ? `${selectedIndex + 1}/${displayItems.length}` : "0/0";
		const lines = [padRightAnsi(`${title}${" ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(counter)))}${this.theme.fg("dim", counter)}`, width)];

		if (displayItems.length === 0) {
			lines.push(padRightAnsi(this.theme.fg("warning", "  No matching settings"), width));
			return lines;
		}

		const [startIndex, endIndex] = getVisibleRange(selectedIndex, displayItems.length, MAX_SETTINGS_ROWS);
		for (let index = startIndex; index < endIndex; index++) {
			const item = displayItems[index];
			if (!item) continue;
			lines.push(this.renderSettingLine(item, index === selectedIndex, width));
		}
		return lines;
	}

	private renderSettingLine(item: ConfigurationItem, selected: boolean, width: number) {
		const focused = this.focusedPane === "settings";
		const selectedColor = focused ? "accent" : "muted";
		const prefix = selected ? "▶ " : "  ";
		const styledPrefix = selected ? this.theme.fg(selectedColor, prefix) : prefix;
		const valueWidth = Math.max(0, Math.min(28, Math.floor(width * 0.4)));
		const labelWidth = Math.max(1, width - 2 - 1 - valueWidth);
		const labelText = this.hasSearchQuery() ? `${item.label} (${this.getCategory(item.categoryId).label})` : item.label;
		const label = fitAnsi(labelText, labelWidth);
		const selectedLabel = focused ? this.theme.bold(label) : label;
		const styledLabel = selected ? this.theme.fg(selectedColor, selectedLabel) : label;
		const value = this.formatValue(item, valueWidth);
		return padRightAnsi(`${styledPrefix}${padRightAnsi(styledLabel, labelWidth)} ${padLeftAnsi(value, valueWidth)}`, width);
	}

	private renderFooterLines(width: number) {
		const selected = this.getSelectedSetting();
		const selection = this.getSelectionText();
		if (this.editingShortcutItem) {
			const hint = this.pendingShortcutValue ? `Captured ${this.pendingShortcutValue} • Enter save • Esc cancel` : "Press desired key or key combination • Enter save • Esc cancel";
			return [this.renderFullLine(width, `${selection} • ${this.statusText || hint}`)];
		}
		const search = this.searchActive ? `Search: ${this.searchQuery || "type to filter all settings"}` : "";
		const lead = this.statusText || search;
		const description = selected?.description ?? this.currentCategory().description;
		const footer = lead ? `${lead} • ${selection} • ${description}` : `${selection} • ${description}`;
		const lines = this.focusedPane === "settings" && selected?.details
			? [footer, ...selected.details].filter(Boolean).flatMap((line) => wrapTextWithAnsi(sanitizeTerminalText(line), width - 2))
			: [footer];
		return lines.map((line) => this.renderFullLine(width, line));
	}

	private formatValue(item: ConfigurationItem, width: number) {
		if (width <= 0) return "";
		if (this.editingShortcutItem?.id === item.id) return this.pendingShortcutValue ? this.theme.fg("accent", fitAnsi(this.pendingShortcutValue, width)) : "";
		const raw = item.rawValue;
		if (!raw) return this.theme.fg("dim", fitAnsi(item.emptyLabel ?? displayConfigurationValue(item.id, raw), width));

		if (item.displayKind === "boolean") {
			const enabled = isTruthyConfigValue(raw);
			return enabled ? this.theme.fg("success", fitAnsi("ON", width)) : this.theme.fg("dim", fitAnsi("OFF", width));
		}

		if (item.displayKind === "slider") return this.formatSlider(item, width);

		const value = item.valueLabels && Object.hasOwn(item.valueLabels, raw) ? item.valueLabels[raw] : raw;
		const label = displayConfigurationValue(item.id, value ?? raw);
		if (item.displayKind === "path" || item.displayKind === "model") return fitTerminalTail(label, width);
		return fitAnsi(label, width);
	}

	private formatSlider(item: ConfigurationItem, width: number) {
		const value = Number(item.rawValue);
		const valueText = Number.isFinite(value) ? value.toFixed(2) : sanitizeTerminalText(item.rawValue);
		if (width < valueText.length + 5) return fitAnsi(valueText, width);

		const ratio = clamp(value / 2, 0, 1);
		const barWidth = Math.max(3, Math.min(10, width - valueText.length - 4));
		const filled = clamp(Math.round(ratio * barWidth), 0, barWidth);
		const bar = `[${"█".repeat(filled)}${"░".repeat(barWidth - filled)}]`;
		return fitAnsi(`${this.theme.fg("accent", bar)} ${valueText}`, width);
	}

	private currentHeaderLabel() {
		if (this.hasSearchQuery()) return "Search";
		return this.currentCategory().label;
	}

	private getSettingsScopeTitle() {
		if (this.hasSearchQuery()) return `SEARCH ${this.searchQuery}`.toUpperCase();
		return this.currentCategory().label.toUpperCase();
	}

	private getSelectionText() {
		const displayItems = this.getDisplaySettings();
		if (displayItems.length === 0) return "0/0";
		return `${this.getSelectedSettingIndex(displayItems.length) + 1}/${displayItems.length}`;
	}

	private currentCategory() {
		return CONFIGURATION_CATEGORIES[this.categoryIndex] ?? CONFIGURATION_CATEGORIES[0]!;
	}

	private getCategory(id: ConfigurationCategoryId) {
		return CONFIGURATION_CATEGORIES.find((category) => category.id === id) ?? CONFIGURATION_CATEGORIES[0]!;
	}

	private getCategoryItems(categoryId = this.currentCategory().id) {
		return this.view.items.filter((item) => item.categoryId === categoryId && this.isItemVisible(item));
	}

	private getVisibleItems() {
		return this.view.items.filter((item) => this.isItemVisible(item));
	}

	private isItemVisible(item: ConfigurationItem) {
		return item.visibleWhen ? item.visibleWhen(this.view.plan) : true;
	}

	private getDisplaySettings() {
		if (!this.hasSearchQuery()) return this.getCategoryItems();
		return fuzzyFilter(this.getVisibleItems(), this.searchQuery, (item) => `${item.label} ${item.id} ${item.description ?? ""} ${this.getCategory(item.categoryId).label}`);
	}

	private getSelectedSetting() {
		const displayItems = this.getDisplaySettings();
		return displayItems[this.getSelectedSettingIndex(displayItems.length)];
	}

	private getSelectedSettingIndex(total: number) {
		if (total <= 0) return 0;
		if (this.hasSearchQuery()) {
			this.selectedSearchIndex = clamp(this.selectedSearchIndex, 0, total - 1);
			return this.selectedSearchIndex;
		}
		const categoryId = this.currentCategory().id;
		const selected = clamp(this.selectedByCategory.get(categoryId) ?? 0, 0, total - 1);
		this.selectedByCategory.set(categoryId, selected);
		return selected;
	}

	private moveSelection(delta: number) {
		if (this.focusedPane === "categories") {
			this.categoryIndex = wrapIndex(this.categoryIndex + delta, CONFIGURATION_CATEGORIES.length);
			return;
		}

		const items = this.getDisplaySettings();
		if (items.length === 0) return;
		const next = wrapIndex(this.getSelectedSettingIndex(items.length) + delta, items.length);
		if (this.hasSearchQuery()) {
			this.selectedSearchIndex = next;
		} else {
			this.selectedByCategory.set(this.currentCategory().id, next);
		}
	}

	private activateSelectedSetting() {
		if (this.saving) return;
		const displayItems = this.getDisplaySettings();
		const item = displayItems[this.getSelectedSettingIndex(displayItems.length)];
		if (!item) return;

		if (item.id === "MICME_SHORTCUT") {
			this.startShortcutCapture(item);
			return;
		}

		if (item.submenu) {
			this.submenuComponent = item.submenu(item.rawValue, (selectedValue?: string) => {
				this.submenuComponent = null;
				if (selectedValue !== undefined) this.saveSetting(item, selectedValue);
				this.requestRender();
			});
			return;
		}

		if (!item.values || item.values.length === 0) return;
		const currentIndex = item.values.indexOf(item.rawValue);
		const nextValue = item.values[(currentIndex + 1) % item.values.length] ?? item.values[0] ?? "";
		this.saveSetting(item, nextValue);
	}

	private startShortcutCapture(item: ConfigurationItem) {
		this.editingShortcutItem = item;
		this.pendingShortcutValue = "";
		this.statusText = "";
		this.requestRender();
	}

	private handleShortcutCaptureInput(data: string) {
		const item = this.editingShortcutItem;
		if (!item) return;

		if (matchesKey(data, "escape")) {
			this.editingShortcutItem = null;
			this.pendingShortcutValue = "";
			this.statusText = "";
			this.requestRender();
			return;
		}

		if (matchesKey(data, "enter")) {
			if (!this.pendingShortcutValue) {
				this.statusText = "Press a shortcut before confirming";
				this.requestRender();
				return;
			}
			const nextValue = this.pendingShortcutValue;
			this.editingShortcutItem = null;
			this.pendingShortcutValue = "";
			this.saveSetting(item, nextValue);
			return;
		}

		const captured = this.readShortcut(data);
		if (!captured) {
			if (captured === null) this.pendingShortcutValue = "";
			this.statusText = captured === null ? "Ambiguous terminal input. Press a different shortcut." : "Shortcut input not recognized";
			this.requestRender();
			return;
		}

		this.pendingShortcutValue = captured;
		this.statusText = "";
		this.requestRender();
	}

	private saveSetting(item: ConfigurationItem, nextValue: string) {
		this.saving = true;
		this.statusText = `Saving ${item.id}…`;
		this.requestRender();

		void this.onSave(item.id, nextValue)
			.then((view) => {
				if (this.closed) return;
				this.view = view;
				this.clampSelections();
				this.statusText = formatSaveStatus(item.id, nextValue);
			})
			.catch((error) => {
				if (this.closed) return;
				this.statusText = "Save failed";
				this.onError(error);
			})
			.finally(() => {
				if (this.closed) return;
				this.saving = false;
				this.requestRender();
			});
	}

	private clampSelections() {
		for (const category of CONFIGURATION_CATEGORIES) {
			const count = this.getCategoryItems(category.id).length;
			this.selectedByCategory.set(category.id, clamp(this.selectedByCategory.get(category.id) ?? 0, 0, Math.max(0, count - 1)));
		}
	}


	private handleSearchInput(data: string) {
		if (matchesKey(data, "/")) {
			this.searchActive = true;
			this.searchQuery = "";
			this.selectedSearchIndex = 0;
			this.focusedPane = "settings";
			return true;
		}

		if (this.searchActive && matchesKey(data, "backspace")) {
			const chars = Array.from(this.searchQuery);
			chars.pop();
			this.searchQuery = chars.join("");
			this.selectedSearchIndex = 0;
			if (!this.searchQuery) this.searchActive = false;
			return true;
		}

		if (this.searchActive && matchesKey(data, "escape")) {
			this.searchActive = false;
			this.searchQuery = "";
			this.selectedSearchIndex = 0;
			this.focusedPane = "categories";
			return true;
		}

		const printable = getPrintableInput(data);
		if (!printable || (!this.searchActive && printable === " ")) return false;
		this.searchActive = true;
		this.searchQuery += printable;
		this.selectedSearchIndex = 0;
		this.focusedPane = "settings";
		return true;
	}

	private hasSearchQuery() {
		return this.searchQuery.trim().length > 0;
	}
}

export function buildConfigurationItems(
	modelCandidates: ModelCandidate[],
	pythonModelCandidatesOrAudioDevices: ModelCandidate[] | AudioDeviceCandidate[],
	audioDevicesOrTheme: AudioDeviceCandidate[] | MicmeTheme,
	maybeTheme?: MicmeTheme,
): ConfigurationItem[] {
	const pythonModelCandidates = maybeTheme ? (pythonModelCandidatesOrAudioDevices as ModelCandidate[]) : [];
	const audioDevices = maybeTheme ? (audioDevicesOrTheme as AudioDeviceCandidate[]) : (pythonModelCandidatesOrAudioDevices as AudioDeviceCandidate[]);
	const theme = maybeTheme ?? (audioDevicesOrTheme as MicmeTheme);
	return buildConfigurationView(modelCandidates, pythonModelCandidates, audioDevices, theme).items;
}

function buildConfigurationView(modelCandidates: ModelCandidate[], pythonModelCandidates: ModelCandidate[], audioDevices: AudioDeviceCandidate[], theme: MicmeTheme): ConfigurationView {
	const mode = getTranscriptionMode();
	const plan = resolveTranscriptionPlan({ transcriptionMode: mode });
	const streamPlan = mode === "stream" ? plan : resolveTranscriptionPlan({ transcriptionMode: "stream" });
	const live = streamPlan.live;
	const model = resolveWhisperCppModel({ transcriptionMode: mode });
	const currentModelPath = plan.live?.modelPath ?? model.path;
	const configuredWorker = env("MICME_LIVE_BIN")?.trim();
	const workerPath = live?.binary ?? (configuredWorker ? expandConfigPath(configuredWorker) : "micme-live (PATH default)");
	const vadPath = live?.vadModelPath ?? getWhisperVadModelPath();
	const liveLanguage = mode === "stream" && live ? `Live language: ${live.language}${live.translate ? " (translate to English)" : ""}.` : "";
	const finalize = flagValue(live?.finalizeWithClip ?? getStreamFinalizeWithClip());
	const diagnostics = flagValue(envFlag("MICME_STREAM_DIAGNOSTICS"));
	const whisperCppBinValues = uniqueStrings([env("MICME_WHISPER_CPP_BIN") ?? "", findExecutable(["whisper-cli"]) ?? "", findExecutable(["whisper-cpp"]) ?? "", "whisper-cli", "whisper-cpp"]);
	const audioFilter = getAudioFilter();
	const shortcut = getShortcutSettingValue(terminalDefaultShortcut);
	const translateToEnglish = getTranslateToEnglishLanguage() ?? "off";
	const backendValues = ["auto", "whisper.cpp", "python"];
	const processing = flagValue(mode === "stream" ? getFlagSetting("MICME_PROCESS_AUDIO", true) : env("MICME_PROCESS_AUDIO") !== "0");
	const validate = flagValue(env("MICME_VALIDATE_AUDIO") !== "0" && !envFlag("MICME_SKIP_AUDIO_VALIDATION"));
	const keepAudio = flagValue(envFlag("MICME_KEEP_AUDIO"));
	const recordMeter = flagValue(getRecordMeter());
	const avfoundationDropLateFrames = flagValue(getAvfoundationDropLateFrames());
	const meterGain = String(getMeterGain());
	const whisperCppVisible = (candidate: ResolvedTranscriptionPlan) => getUiBackendValue(candidate) === "whisper.cpp";
	const pythonVisible = (candidate: ResolvedTranscriptionPlan) => getUiBackendValue(candidate) === "python";
	const currentPythonModel = getPythonWhisperModelName();
	const pythonModelValues = uniqueStrings([currentPythonModel, env("MICME_WHISPER_MODEL") ?? "", ...pythonModelCandidates.map((candidate) => candidate.value)]);
	const pythonModelLabels = Object.fromEntries(pythonModelCandidates.map((candidate) => [candidate.value, candidate.label]));
	const modelPathCandidates = [{ label: "Use default model", value: "", description: "Clear explicit path override and use Micme's default whisper.cpp model path.", installed: true, kind: "path" as const }, ...modelCandidates];

	const items: ConfigurationItem[] = [
		{
			id: "MICME_AUTO_DOWNLOAD_MODEL",
			categoryId: "general",
			label: "Auto-download models",
			description: "Download missing whisper.cpp models automatically when selected or first used.",
			rawValue: getAutoDownloadModel() ? "1" : "0",
			currentValue: getAutoDownloadModel() ? "1" : "0",
			values: ["1", "0"],
			displayKind: "boolean",
		},
		{
			id: "MICME_LANGUAGE",
			categoryId: "general",
			label: "Language",
			description: "Transcription language when translation is off. Use auto for detection.",
			rawValue: env("MICME_LANGUAGE")?.trim() || "en",
			currentValue: env("MICME_LANGUAGE")?.trim() || "en",
			details: liveLanguage ? [liveLanguage] : undefined,
			values: [...TRANSCRIPTION_LANGUAGE_VALUES],
			valueLabels: LANGUAGE_LABELS,
			displayKind: "text",
		},
		{
			id: "MICME_TRANSLATE_TO_ENGLISH",
			categoryId: "general",
			label: "Translate from",
			description: "Off by default. Choose the spoken source language to output English.",
			rawValue: translateToEnglish,
			currentValue: translateToEnglish,
			details: liveLanguage ? [liveLanguage] : undefined,
			values: ["off", ...TRANSLATION_SOURCE_LANGUAGE_VALUES],
			valueLabels: TRANSLATE_FROM_VALUE_LABELS,
			displayKind: "text",
		},
		{
			id: "MICME_TRANSCRIPTION_MODE",
			categoryId: "transcription",
			label: "Transcription mode",
			description: "Resets the Stream final pass (off for stream, on for clip). Stream needs a local decoder and speech detector (see Streaming).",
			details: mode === "stream" && !live ? [streamPlan.reason, "Choose clip mode or fix live setup, then reopen settings."] : [],
			rawValue: mode,
			currentValue: mode,
			values: ["clip", "stream"],
			displayKind: "text",
		},
		{
			id: "MICME_TRANSCRIBE_BACKEND",
			categoryId: "transcription",
			label: "Backend",
			description: "Stream uses whisper.cpp; select Auto or whisper.cpp. Python and custom backends are clip-only.",
			details: [plan.effectiveBackend === "none" ? plan.reason : `Effective backend: ${formatBackendLabel(plan.effectiveBackend)}.`],
			rawValue: plan.requestedBackend,
			currentValue: plan.requestedBackend,
			values: backendValues,
			valueLabels: { auto: "Auto", "whisper.cpp": "whisper.cpp", python: "Python Whisper", custom: "Custom command" },
			displayKind: "text",
		},
		{
			id: "MICME_WHISPER_CPP_MODEL",
			categoryId: "transcription",
			label: "ASR model",
			description: "Whisper.cpp model for speech recognition in clip and live dictation.",
			details: [
				model.exists ? currentModelPath : `ASR model file is missing: ${currentModelPath}`,
				shellOverrideHint("MICME_WHISPER_CPP_MODEL"),
				liveLanguage,
			],
			rawValue: currentModelPath,
			currentValue: displayConfigurationValue("MICME_WHISPER_CPP_MODEL", currentModelPath),
			displayKind: "model",
			emptyLabel: "not set",
			submenu: (_currentValue, done) => createModelSelector(modelPathCandidates, theme, done),
			visibleWhen: whisperCppVisible,
		},
		{
			id: "MICME_WHISPER_CPP_BIN",
			categoryId: "transcription",
			label: "Clip binary",
			description: "Whisper.cpp CLI for clip transcription or final refinement. Stream uses the local decoder in Streaming.",
			rawValue: env("MICME_WHISPER_CPP_BIN") ?? "",
			currentValue: displayConfigurationValue("MICME_WHISPER_CPP_BIN", env("MICME_WHISPER_CPP_BIN") ?? ""),
			values: whisperCppBinValues,
			displayKind: "path",
			emptyLabel: "not set",
			visibleWhen: whisperCppVisible,
		},
		{
			id: "MICME_WHISPER_MODEL",
			categoryId: "transcription",
			label: "Model",
			description: "Model name passed to the OpenAI Whisper Python CLI.",
			rawValue: currentPythonModel,
			currentValue: currentPythonModel,
			values: pythonModelValues,
			valueLabels: pythonModelLabels,
			displayKind: "text",
			visibleWhen: pythonVisible,
		},

		{
			id: "MICME_LIVE_BIN",
			categoryId: "streaming",
			label: "Live decoder",
			description: configFileHelp("MICME_LIVE_BIN"),
			details: [
				shellOverrideHint("MICME_LIVE_BIN"),
				live || !streamPlan.reason.includes(workerPath) ? workerPath : "",
				live ? "" : streamPlan.reason,
				`Uses the input in Audio: speech-gated ${LIVE_CAPTURE_RATE / 1000} kHz mono PCM.`,
			],
			rawValue: workerPath,
			currentValue: displayConfigurationValue("MICME_LIVE_BIN", workerPath),
			displayKind: "path",
		},
		{
			id: "MICME_VAD_MODEL",
			categoryId: "streaming",
			label: "Speech detector model",
			description: configFileHelp("MICME_VAD_MODEL"),
			details: [shellOverrideHint("MICME_VAD_MODEL"), vadModelStatus(vadPath)],
			rawValue: vadPath,
			currentValue: displayConfigurationValue("MICME_VAD_MODEL", vadPath),
			displayKind: "path",
		},
		{
			id: "MICME_STREAM_FINALIZE_WITH_CLIP",
			categoryId: "streaming",
			label: "Stream final pass",
			description: "Refine the transcript on stop using the clip backend on the same capture, without re-filtering.",
			details: [shellOverrideHint("MICME_STREAM_FINALIZE_WITH_CLIP")],
			rawValue: finalize,
			currentValue: finalize,
			values: ["0", "1"],
			displayKind: "boolean",
		},
		buildMicrophoneItem(audioDevices),
		{
			id: "MICME_RECORD_SAMPLE_RATE",
			categoryId: "audio",
			label: "Sample rate override",
			description: `Built-in clip recorder only. Auto keeps the input rate; live captures at ${LIVE_CAPTURE_RATE / 1000} kHz.`,
			details: [],
			rawValue: String(getRecordSampleRate() ?? "auto"),
			currentValue: String(getRecordSampleRate() ?? "auto"),
			values: ["auto", "48000", "44100", "16000", "96000"],
			displayKind: "text",
		},
		{
			id: "MICME_RECORD_SYNC",
			categoryId: "audio",
			label: "Record timing sync",
			description: "Preserve wall-clock duration using FFmpeg timestamps in built-in clip and live capture.",
			details: [],
			rawValue: getRecordSync() ? "1" : "0",
			currentValue: getRecordSync() ? "1" : "0",
			values: ["1", "0"],
			displayKind: "boolean",
		},
		{
			id: "MICME_TRANSCRIBE_SAMPLE_RATE",
			categoryId: "audio",
			label: "Transcribe sample rate",
			description: "Clip preprocessing only: output rate for clip.wav. Live and its final pass use the captured PCM.",
			details: [],
			rawValue: String(getTranscribeSampleRate()),
			currentValue: String(getTranscribeSampleRate()),
			values: ["16000", "48000", "44100"],
			displayKind: "number",
		},
		{
			id: "MICME_RECORD_METER",
			categoryId: "audio",
			label: "Clip meter pipe",
			description: "Optional FFmpeg meter branch for clip capture only. Live meters the decoder's actual PCM.",
			details: [],
			rawValue: recordMeter,
			currentValue: recordMeter,
			values: ["0", "1"],
			displayKind: "boolean",
		},
		...(process.platform === "darwin"
			? [
					{
						id: "MICME_AVFOUNDATION_DROP_LATE_FRAMES",
						categoryId: "audio" as const,
						label: "AVF drop late frames",
						description: "Built-in AVFoundation input. Keep off to preserve audio timing when devices or virtual routes lag.",
						rawValue: avfoundationDropLateFrames,
						currentValue: avfoundationDropLateFrames,
						values: ["0", "1"],
						displayKind: "boolean" as const,
					},
				]
			: []),
		{
			id: "MICME_AUDIO_FILTER",
			categoryId: "audio",
			label: "Audio filter",
			description: "With preprocessing on, filter clip audio or apply once in built-in live capture. Empty means no filter.",
			details: ["A custom live recorder supplies its own filtered or unfiltered PCM."],
			rawValue: audioFilter,
			currentValue: displayConfigurationValue("MICME_AUDIO_FILTER", audioFilter),
			values: ["highpass=f=80,lowpass=f=7600", "", "highpass=f=80,lowpass=f=9000", "afftdn=nf=-25,highpass=f=80,lowpass=f=7600"],
			displayKind: "text",
			emptyLabel: "<empty>",
		},
		{
			id: "MICME_METER_GAIN",
			categoryId: "audio",
			label: "Meter gain",
			description: "Recording widget sensitivity. Increase if the bars feel too quiet.",
			rawValue: meterGain,
			currentValue: meterGain,
			values: ["0.75", "1", "1.5", "2", "3"],
			displayKind: "slider",
		},
		{
			id: "MICME_PROCESS_AUDIO",
			categoryId: "audio",
			label: "Preprocess audio",
			description: "Convert/filter clips or enable the filter for built-in live capture. Live always uses fixed-rate PCM.",
			details: ["Custom live recorders own all filtering. The live final pass never re-filters."],
			rawValue: processing,
			currentValue: processing,
			values: ["1", "0"],
			displayKind: "boolean",
		},
		{
			id: "MICME_VALIDATE_AUDIO",
			categoryId: "audio",
			label: "Silence guard",
			description: "Reject near-silent clips, including optional live refinement. During speech, the live decoder uses its speech detector instead.",
			details: [],
			rawValue: validate,
			currentValue: validate,
			values: ["1", "0"],
			displayKind: "boolean",
		},
		{
			id: "MICME_KEEP_AUDIO",
			categoryId: "audio",
			label: "Keep audio",
			description: "Keep the recording under ./micme-rec/rec-###/ after transcription (not the live refinement copy).",
			rawValue: keepAudio,
			currentValue: keepAudio,
			values: ["0", "1"],
			displayKind: "boolean",
		},
		{
			id: "MICME_SHORTCUT",
			categoryId: "general",
			label: "Shortcut",
			description: "Press Enter, then press the desired key or key combination, and press Enter again to confirm.",
			rawValue: shortcut,
			currentValue: displayConfigurationValue("MICME_SHORTCUT", shortcut),
			displayKind: "text",
			emptyLabel: "not set",
		},
		{
			id: "MICME_STREAM_DIAGNOSTICS",
			categoryId: "general",
			label: "Stream diagnostics",
			description: "Show local decoder load/recognition timings and capture counts, not transcript text.",
			details: [shellOverrideHint("MICME_STREAM_DIAGNOSTICS")],
			rawValue: diagnostics,
			currentValue: diagnostics,
			values: ["0", "1"],
			displayKind: "boolean",
		},
	];
	return { plan, items };
}

function buildMicrophoneItem(audioDevices: AudioDeviceCandidate[]): ConfigurationItem {
	const { platform } = process;
	const id = getAudioInputConfigKey(platform);
	const customRecorder = Boolean(env("MICME_RECORD_COMMAND")?.trim());
	const avfoundationOverride = platform === "darwin" ? env("MICME_AVFOUNDATION_INPUT") : undefined;
	const selected = env(id) || (platform === "linux" ? "default" : platform === "win32" ? "" : "0");
	const current = customRecorder ? "Custom recorder" : avfoundationOverride || selected;
	const values = audioDevices.map((device) => device.value);
	if (!values.includes(selected)) values.unshift(selected);
	let description = platform === "win32" ? "Windows DirectShow audio input name." : "macOS avfoundation audio device id";
	let details = [shellOverrideHint(id)];
	if (platform === "linux") {
		description = `PulseAudio source. ${configFileHelp(id)}`;
		details.push(`Input: ${selected}`);
	}
	if (customRecorder) {
		description = "MICME_RECORD_COMMAND takes precedence over the microphone picker and built-in capture settings.";
		details = [shellOverrideHint("MICME_RECORD_COMMAND"), `Custom live capture must write a growing ${LIVE_CAPTURE_RATE / 1000} kHz mono signed 16-bit PCM WAV.`];
	} else if (avfoundationOverride) {
		description = "MICME_AVFOUNDATION_INPUT overrides MICME_AUDIO_DEVICE.";
		details = [shellOverrideHint("MICME_AVFOUNDATION_INPUT"), `Input: ${avfoundationOverride}`, configFileHelp("MICME_AVFOUNDATION_INPUT")];
	}
	return {
		id,
		categoryId: "audio",
		label: "Microphone device",
		description,
		details,
		rawValue: current,
		currentValue: current,
		values: customRecorder || avfoundationOverride ? undefined : values,
		displayKind: "text",
		emptyLabel: platform === "win32" ? "Automatic" : undefined,
		valueLabels: customRecorder || avfoundationOverride ? undefined : Object.fromEntries(audioDevices.map((device) => [device.value, device.label])),
	};
}

function configFileHelp(key: string) {
	return `Set ${key} in micme.json or your shell; restart Pi.`;
}

function shellOverrideHint(key: string) {
	return process.env[key] === undefined ? "" : `Shell override: ${key}.`;
}

function vadModelStatus(path: string) {
	return isRegularFile(path) ? path : `Speech detector model file is missing or unavailable: ${path}`;
}

function flagValue(enabled: boolean) {
	return enabled ? "1" : "0";
}

const MAX_MODEL_ROWS = 16;

type ModelSelection = { label: string; description: string; value: string };

class ModelSelector implements TerminalRows {
	private readonly items: ModelSelection[];
	private readonly theme: MicmeTheme;
	private readonly done: (value?: string) => void;
	private filter = "";
	private index = 0;

	constructor(candidates: ModelCandidate[], theme: MicmeTheme, done: (value?: string) => void) {
		this.theme = theme;
		this.done = done;
		this.items = candidates.map((candidate) => ({
			value: candidate.value,
			label: `${candidate.installed ? "✓" : "○"} ${sanitizeTerminalText(candidate.label) || "model"}`,
			description: sanitizeTerminalText(candidate.description),
		}));
	}

	render(width: number) {
		const { theme } = this;
		const items = this.visibleItems();
		const [start, end] = getVisibleRange(this.index, items.length, MAX_MODEL_ROWS);
		const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
		const rows = [border, theme.fg("accent", theme.bold(" Select whisper.cpp model")), ...this.hintRows("✓ found locally • ○ missing; selecting downloads automatically when enabled", width)];
		if (this.filter) rows.push(theme.fg("dim", ` Search: ${this.filter}`));
		if (items.length === 0) rows.push(theme.fg("warning", "  No matching models"));
		for (let index = start; index < end; index++) {
			const item = items[index]!;
			const prefix = index === this.index ? "→ " : "  ";
			const label = prefix + fitAnsi(item.label, Math.max(0, (width > 40 ? Math.min(32, Math.floor(width / 2)) : width) - 2));
			const description = width > 40 && item.description ? `  ${theme.fg("muted", item.description)}` : "";
			rows.push(index === this.index ? theme.fg("accent", label) + description : label + description);
		}
		if (items.length > MAX_MODEL_ROWS) rows.push(theme.fg("dim", `  (${this.index + 1}/${items.length})`));
		rows.push(...this.hintRows("↑↓ navigate • type to search • enter select • esc back", width), border);
		return rows.map((line) => fitAnsi(line, width, ""));
	}

	invalidate() { /* Rows are rendered directly from the current selection. */ }

	handleInput(data: string) {
		if (matchesSelectionAction(data, "cancel")) return this.done();
		const items = this.visibleItems();
		if (matchesSelectionAction(data, "confirm")) {
			const item = items[this.index];
			if (item) this.done(item.value);
			return;
		}
		if (matchesSelectionAction(data, "up")) this.index = wrapIndex(this.index - 1, items.length);
		else if (matchesSelectionAction(data, "down")) this.index = wrapIndex(this.index + 1, items.length);
		else if (matchesSelectionAction(data, "pageUp")) this.index = Math.max(0, this.index - MAX_MODEL_ROWS);
		else if (matchesSelectionAction(data, "pageDown")) this.index = clamp(this.index + MAX_MODEL_ROWS, 0, Math.max(0, items.length - 1));
		else {
			const printable = getPrintableInput(data);
			if (matchesKey(data, "backspace")) this.filter = Array.from(this.filter).slice(0, -1).join("");
			else if (printable) this.filter += printable;
			else return;
			this.index = 0;
		}
	}

	private visibleItems() {
		return this.filter ? fuzzyFilter(this.items, this.filter, (item) => `${item.label} ${item.description}`) : this.items;
	}

	private hintRows(text: string, width: number) {
		return wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => this.theme.fg("dim", ` ${line}`));
	}
}

export function createModelSelector(candidates: ModelCandidate[], theme: MicmeTheme, done: (selectedValue?: string) => void): TerminalRows {
	return new ModelSelector(candidates, theme, done);
}

export async function saveConfigurationValue(ctx: ExtensionContext, id: string, value: string, options: { signal?: AbortSignal } = {}): Promise<Record<string, string>> {
	if (!id.startsWith("MICME_")) return {};
	options.signal?.throwIfAborted();
	requireValidMicmeConfig();

	const valuesToWrite = getConfigurationValuesToWrite(id, value);
	if (id === "MICME_WHISPER_CPP_MODEL" && value) {
		await ensureWhisperCppModel(expandConfigPath(value), ctx, { signal: options.signal });
	}

	options.signal?.throwIfAborted();
	await writeMicmeConfigValues(valuesToWrite, { signal: options.signal });
	reloadMicmeConfig();

	const effectiveValues: Record<string, string> = {};
	for (const key of Object.keys(valuesToWrite)) effectiveValues[key] = env(key) ?? "";
	return effectiveValues;
}

export function displayConfigurationValue(id: string, value: string) {
	if (id === "MICME_WHISPER_CPP_MODEL") return value ? sanitizeTerminalText(basename(value)) || "model" : "not set";
	if (id === "MICME_TRANSCRIBE_COMMAND" || id === "MICME_RECORD_COMMAND") return value ? "configured" : "not set";
	if (id === "MICME_AUDIO_FILTER") return sanitizeTerminalText(value) || "<empty>";
	return sanitizeTerminalText(value) || "not set";
}

function getUiBackendValue(plan: ResolvedTranscriptionPlan): "whisper.cpp" | "python" {
	if (plan.requestedBackend === "python" || plan.requestedBackend === "whisper.cpp") return plan.requestedBackend;
	return plan.effectiveBackend === "python" ? "python" : "whisper.cpp";
}

export function uniqueStrings(values: string[]) {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		output.push(normalized);
	}
	return output.length > 0 ? output : [""];
}

function getConfigurationValuesToWrite(id: string, value: string) {
	if (id === "MICME_TRANSCRIPTION_MODE") return getTranscriptionModeProfile(value === "stream" ? "stream" : "clip");
	if (id === "MICME_SHORTCUT") return { MICME_SHORTCUT: value, MICME_PRINTABLE_SHORTCUTS: undefined };
	if (id === "MICME_WHISPER_CPP_MODEL" && !value) return { MICME_WHISPER_CPP_MODEL: undefined };
	return { [id]: value };
}

function formatSaveStatus(id: string, value: string) {
	const writtenKeys = Object.keys(getConfigurationValuesToWrite(id, value));
	const overriddenKeys = writtenKeys.filter((key) => process.env[key] !== undefined);
	const reloadHint = getConfigurationReloadHint(id);

	if (id === "MICME_TRANSCRIPTION_MODE" && overriddenKeys.length) return `Shell env still overrides ${overriddenKeys.join(", ")}`;
	if (overriddenKeys.length) return reloadHint ? `Shell env still overrides ${overriddenKeys.join(", ")} • ${reloadHint}` : `Shell env still overrides ${overriddenKeys.join(", ")}`;
	return reloadHint;
}

function getConfigurationReloadHint(id: string) {
	if (id === "MICME_SHORTCUT") return "/reload required for shortcut changes";
	if (id === "MICME_PRINTABLE_SHORTCUTS") return "/reload recommended for printable shortcuts";
	return "";
}

function fitAnsi(text: string, width: number, ellipsis = "…") {
	if (width <= 0) return "";
	return truncateToWidth(text, width, ellipsis);
}

function padRightAnsi(text: string, width: number) {
	const fitted = fitAnsi(text, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function padLeftAnsi(text: string, width: number) {
	const fitted = fitAnsi(text, width);
	return `${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`;
}

function getVisibleRange(selectedIndex: number, total: number, maxVisible: number): [number, number] {
	if (total <= maxVisible) return [0, total];
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
	return [start, Math.min(total, start + maxVisible)];
}

function wrapIndex(index: number, length: number) {
	if (length <= 0) return 0;
	return ((index % length) + length) % length;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function isTruthyConfigValue(value: string) {
	return /^(1|true|yes|on)$/i.test(value);
}

function getShortcutInput(data: string, ui: ExtensionContext["ui"]) {
	const parsed = parseShortcutKey(data, ui);
	if (parsed === null) return null;
	if (parsed && parsed !== "enter" && parsed !== "escape" && parsed !== "esc" && sanitizeTerminalText(parsed) === parsed) return parsed;
	return getPrintableInput(data);
}

function getPrintableInput(data: string) {
	const text = decodeKittyPrintable(data) ?? data;
	return text && !/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(text) ? text : "";
}
