import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	decodeKittyPrintable,
	fuzzyFilter,
	Key,
	matchesKey,
	parseKey,
	type Component,
	type SelectItem,
	SelectList,
	type SettingItem,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { basename } from "node:path";
import {
	DEFAULT_RECORD_SAMPLE_RATE,
	DEFAULT_STREAM_VAD_THRESHOLD,
	DEFAULT_STREAM_FLUSH_MS,
	DEFAULT_TRANSCRIBE_SAMPLE_RATE,
} from "./constants.ts";
import {
	env,
	expandConfigPath,
	getShortcutSettingValue,
	getTranscriptionMode,
	getTranscriptionModeProfile,
	reloadMicmeConfig,
	writeMicmeConfigValues,
} from "./config.ts";
import { discoverAudioDevices } from "./audio.ts";
import { formatBackendLabel, resolveTranscriptionPlan } from "./backends.ts";
import { discoverPythonWhisperModels, discoverWhisperCppModels, ensureWhisperCppModel, resolveWhisperCppModel } from "./models.ts";
import { findExecutable } from "./processes.ts";
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

interface ConfigurationItem extends SettingItem {
	categoryId: ConfigurationCategoryId;
	rawValue: string;
	displayKind?: DisplayKind;
	emptyLabel?: string;
	valueLabels?: Record<string, string>;
	visibleWhen?: (plan: ResolvedTranscriptionPlan) => boolean;
}

const CONFIGURATION_CATEGORIES: ConfigurationCategory[] = [
	{ id: "general", label: "General", description: "Core defaults used by Micme." },
	{ id: "transcription", label: "Transcription", description: "Backend model, mode, and transcription fallback settings." },
	{ id: "streaming", label: "Streaming", description: "Low-latency live transcription behavior." },
	{ id: "audio", label: "Audio", description: "Recording, preprocessing, and metering settings." },
];

const TWO_PANE_MIN_WIDTH = 72;
const MAX_SETTINGS_ROWS = 10;

export async function showConfiguration(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/micme conf requires interactive TUI mode.", "warning");
		return;
	}

	const configState = reloadMicmeConfig();
	if (configState.error) {
		ctx.ui.notify(`Micme config is invalid at ${configState.path}: ${configState.error}. Fix it before saving settings.`, "warning");
	}
	const audioDevices = await discoverAudioDevices();
	const modelCandidates = discoverWhisperCppModels(ctx.cwd);
	const pythonModelCandidates = await discoverPythonWhisperModels();

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const items = buildConfigurationItems(modelCandidates, pythonModelCandidates, audioDevices, theme);
		return new ConfigurationScreen({
			configPath: configState.path,
			items,
			theme,
			onDone: done,
			onError: (error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"),
			onSave: (id, newValue) => saveConfigurationValue(ctx, id, newValue),
			requestRender: () => tui.requestRender(),
		});
	});
}

class ConfigurationScreen implements Component {
	private readonly configPath: string;
	private readonly items: ConfigurationItem[];
	private readonly theme: MicmeTheme;
	private readonly onDone: () => void;
	private readonly onError: (error: unknown) => void;
	private readonly onSave: (id: string, newValue: string) => Promise<Record<string, string>>;
	private readonly requestRender: () => void;
	private focusedPane: FocusedPane = "categories";
	private categoryIndex = 0;
	private selectedByCategory = new Map<ConfigurationCategoryId, number>();
	private searchActive = false;
	private searchQuery = "";
	private selectedSearchIndex = 0;
	private submenuComponent: Component | null = null;
	private editingShortcutItem: ConfigurationItem | null = null;
	private pendingShortcutValue = "";
	private saving = false;
	private statusText = "";

	constructor(options: {
		configPath: string;
		items: ConfigurationItem[];
		theme: MicmeTheme;
		onDone: () => void;
		onError: (error: unknown) => void;
		onSave: (id: string, newValue: string) => Promise<Record<string, string>>;
		requestRender: () => void;
	}) {
		this.configPath = options.configPath;
		this.items = options.items;
		this.theme = options.theme;
		this.onDone = options.onDone;
		this.onError = options.onError;
		this.onSave = options.onSave;
		this.requestRender = options.requestRender;
		for (const category of CONFIGURATION_CATEGORIES) this.selectedByCategory.set(category.id, 0);
	}

	render(width: number): string[] {
		this.refreshDerivedItems();
		if (this.submenuComponent) return this.submenuComponent.render(width);
		if (width < TWO_PANE_MIN_WIDTH) return this.renderNarrow(width);
		return this.renderTwoPane(width);
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	handleInput(data: string): void {
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		if (this.editingShortcutItem) {
			this.handleShortcutCaptureInput(data);
			return;
		}

		if (matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") {
			this.onDone();
			return;
		}

		if (this.handleSearchInput(data)) return;

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.focusedPane = this.focusedPane === "categories" ? "settings" : "categories";
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (this.focusedPane === "categories") {
				this.focusedPane = "settings";
			} else {
				this.activateSelectedSetting();
			}
			return;
		}

		if (matchesKey(data, Key.space) && this.focusedPane === "settings") {
			this.activateSelectedSetting();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.focusedPane === "settings") {
				this.focusedPane = "categories";
			} else {
				this.onDone();
			}
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

		lines.push(this.renderTitleBorder(width, this.currentHeaderLabel()));
		lines.push(this.renderFullLine(width, this.renderConfigSourceText(width)));
		lines.push(this.renderFullLine(width, "↑↓ move  Tab pane  Enter edit  / search  Esc back  q quit"));
		lines.push(this.renderPaneSeparator(width, leftWidth, rightWidth, "top"));

		for (let index = 0; index < paneHeight; index++) {
			const left = categoryLines[index] ?? "";
			const right = settingsLines[index] ?? "";
			lines.push(this.renderPaneLine(left, right, leftWidth, rightWidth));
		}

		lines.push(this.renderPaneSeparator(width, leftWidth, rightWidth, "bottom"));
		lines.push(this.renderFullLine(width, this.renderFooterText()));
		lines.push(this.colorBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`, width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderNarrow(width: number): string[] {
		if (width < 24) return this.renderTiny(width);

		const innerWidth = width - 2;
		const showCategories = this.focusedPane === "categories" && !this.hasSearchQuery();
		const bodyLines = showCategories ? this.renderCategoryPaneLines(innerWidth) : this.renderSettingsPaneLines(innerWidth);
		const lines: string[] = [];

		lines.push(this.renderTitleBorder(width, this.currentHeaderLabel()));
		lines.push(this.renderFullLine(width, this.renderConfigSourceText(width)));
		lines.push(this.renderFullLine(width, showCategories ? "↑↓ category  Enter open  / search  q quit" : "↑↓ move  Enter edit  Esc categories  / search  q quit"));
		lines.push(this.colorBorder(`├${"─".repeat(innerWidth)}┤`, width));
		for (const line of bodyLines) lines.push(this.renderFullLine(width, line));
		lines.push(this.colorBorder(`├${"─".repeat(innerWidth)}┤`, width));
		lines.push(this.renderFullLine(width, this.renderFooterText()));
		lines.push(this.colorBorder(`╰${"─".repeat(innerWidth)}╯`, width));
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

	private renderConfigSourceText(width: number) {
		const innerWidth = Math.max(0, width - 2);
		const prefix = "writes ";
		const suffix = " • shell env overrides Micme settings";
		const pathWidth = Math.max(0, innerWidth - visibleWidth(prefix) - visibleWidth(suffix));
		const path = pathWidth > 0 ? fitPath(this.configPath, pathWidth) : "micme.json";
		return `${prefix}${path}${suffix}`;
	}

	private renderCategoryPaneLines(width: number) {
		return CONFIGURATION_CATEGORIES.map((category, index) => {
			const selected = index === this.categoryIndex;
			const focused = this.focusedPane === "categories";
			const prefix = selected ? "▶ " : "  ";
			const styledPrefix = selected ? this.theme.fg(focused ? "accent" : "muted", prefix) : prefix;
			const label = fitAnsi(category.label, Math.max(0, width - 2));
			const styledLabel = selected ? this.theme.fg(focused ? "accent" : "muted", focused ? this.theme.bold(label) : label) : this.theme.fg("dim", label);
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
		const prefix = selected ? "▶ " : "  ";
		const styledPrefix = selected ? this.theme.fg(focused ? "accent" : "muted", prefix) : prefix;
		const valueWidth = Math.max(0, Math.min(28, Math.floor(width * 0.4)));
		const labelWidth = Math.max(1, width - 2 - 1 - valueWidth);
		const labelText = this.hasSearchQuery() ? `${item.label} (${this.getCategory(item.categoryId).label})` : item.label;
		const label = fitAnsi(labelText, labelWidth);
		const styledLabel = selected ? this.theme.fg(focused ? "accent" : "muted", focused ? this.theme.bold(label) : label) : label;
		const value = this.formatValue(item, valueWidth);
		return padRightAnsi(`${styledPrefix}${padRightAnsi(styledLabel, labelWidth)} ${padLeftAnsi(value, valueWidth)}`, width);
	}

	private renderFooterText() {
		const selected = this.getSelectedSetting();
		const category = this.currentCategory();
		const selection = this.getSelectionText();
		if (this.editingShortcutItem) {
			const hint = this.pendingShortcutValue ? `Captured ${this.pendingShortcutValue} • Enter save • Esc cancel` : "Press desired key or key combination • Enter save • Esc cancel";
			return `${selection} • ${this.statusText || hint}`;
		}
		const search = this.searchActive ? `Search: ${this.searchQuery || "type to filter all settings"}` : "";
		const lead = this.statusText || search;
		const description = selected?.description ?? category.description;
		return lead ? `${lead} • ${selection} • ${description}` : `${selection} • ${description}`;
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

		const label = item.valueLabels?.[raw] ?? displayConfigurationValue(item.id, raw);
		if (item.displayKind === "path" || item.displayKind === "model") return fitPath(label, width);
		return fitAnsi(label, width);
	}

	private formatSlider(item: ConfigurationItem, width: number) {
		const value = Number(item.rawValue);
		const valueText = Number.isFinite(value) ? value.toFixed(2) : item.rawValue;
		if (width < valueText.length + 5) return fitAnsi(valueText, width);

		const ratio = item.id === "MICME_STREAM_VAD_THRESHOLD" ? clamp(value, 0, 1) : clamp(value / 2, 0, 1);
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
		const plan = this.getCurrentPlan();
		return this.items.filter((item) => item.categoryId === categoryId && this.isItemVisible(item, plan));
	}

	private getVisibleItems() {
		const plan = this.getCurrentPlan();
		return this.items.filter((item) => this.isItemVisible(item, plan));
	}

	private isItemVisible(item: ConfigurationItem, plan: ResolvedTranscriptionPlan) {
		return item.visibleWhen ? item.visibleWhen(plan) : true;
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

		if (matchesKey(data, Key.escape)) {
			this.editingShortcutItem = null;
			this.pendingShortcutValue = "";
			this.statusText = "";
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter)) {
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

		const captured = getShortcutInput(data);
		if (!captured) {
			this.statusText = "Shortcut input not recognized";
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
			.then((updatedValues) => {
				this.updateValues(updatedValues);
				this.refreshDerivedItems();
				this.clampSelections();
				this.statusText = formatSaveStatus(item.id, nextValue);
			})
			.catch((error) => {
				this.statusText = "Save failed";
				this.onError(error);
			})
			.finally(() => {
				this.saving = false;
				this.requestRender();
			});
	}

	private updateValues(values: Record<string, string>) {
		for (const [id, rawValue] of Object.entries(values)) {
			const item = this.items.find((candidate) => candidate.id === id);
			if (!item) continue;
			item.rawValue = rawValue;
			item.currentValue = displayConfigurationValue(id, rawValue);
		}
	}

	private refreshDerivedItems() {
		const plan = this.getCurrentPlan();
		const backend = this.items.find((candidate) => candidate.id === "MICME_TRANSCRIBE_BACKEND");
		if (backend && !["whisper.cpp", "python"].includes(backend.rawValue)) {
			backend.rawValue = getUiBackendValue(plan);
			backend.currentValue = displayConfigurationValue(backend.id, backend.rawValue);
		}

		const model = this.items.find((candidate) => candidate.id === "MICME_WHISPER_CPP_MODEL");
		if (model) {
			model.rawValue = getCurrentWhisperCppModelValue();
			model.currentValue = displayConfigurationValue(model.id, model.rawValue);
		}

		const mode = this.items.find((candidate) => candidate.id === "MICME_TRANSCRIPTION_MODE");
		if (mode) {
			const base = "Changing this applies the matching profile: stable clip defaults or low-latency stream settings.";
			mode.description = plan.requestedBackend === "python" || plan.requestedBackend === "custom"
				? `${base} Streaming mode requires whisper.cpp. Switch to clip mode or choose auto/whisper.cpp.`
				: base;
		}
	}

	private getCurrentPlan() {
		return resolveTranscriptionPlan({ transcriptionMode: getTranscriptionMode() });
	}

	private clampSelections() {
		for (const category of CONFIGURATION_CATEGORIES) {
			const count = this.getCategoryItems(category.id).length;
			this.selectedByCategory.set(category.id, clamp(this.selectedByCategory.get(category.id) ?? 0, 0, Math.max(0, count - 1)));
		}
	}


	private handleSearchInput(data: string) {
		if (matchesKey(data, Key.slash)) {
			this.searchActive = true;
			this.searchQuery = "";
			this.selectedSearchIndex = 0;
			this.focusedPane = "settings";
			return true;
		}

		if (this.searchActive && matchesKey(data, Key.backspace)) {
			const chars = Array.from(this.searchQuery);
			chars.pop();
			this.searchQuery = chars.join("");
			this.selectedSearchIndex = 0;
			if (!this.searchQuery) this.searchActive = false;
			return true;
		}

		if (this.searchActive && matchesKey(data, Key.escape)) {
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
	const currentModelPath = getCurrentWhisperCppModelValue();
	const currentDevice = env("MICME_AUDIO_DEVICE") ?? "0";
	const audioValues = audioDevices.length > 0 ? audioDevices.map((device) => device.value) : [currentDevice];
	if (!audioValues.includes(currentDevice)) audioValues.unshift(currentDevice);
	const audioLabels = Object.fromEntries(audioDevices.map((device) => [device.value, device.label]));
	const whisperCppBinValues = uniqueStrings([env("MICME_WHISPER_CPP_BIN") ?? "", findExecutable(["whisper-cli"]) ?? "", findExecutable(["whisper-cpp"]) ?? "", "whisper-cli", "whisper-cpp"]);
	const whisperStreamBinValues = uniqueStrings([env("MICME_WHISPER_STREAM_BIN") ?? "", findExecutable(["whisper-stream"]) ?? "", "whisper-stream"]);
	const audioFilter = env("MICME_AUDIO_FILTER") ?? "highpass=f=80,lowpass=f=7600";
	const shortcut = getShortcutSettingValue();
	const plan = resolveTranscriptionPlan({ transcriptionMode: getTranscriptionMode() });
	const backendValues = ["whisper.cpp", "python"] as const;
	const backendLabels = Object.fromEntries(backendValues.map((value) => [value, formatBackendLabel(value)]));
	const uiBackendValue = getUiBackendValue(plan);
	const whisperCppVisible = (candidate: ResolvedTranscriptionPlan) => getUiBackendValue(candidate) === "whisper.cpp";
	const pythonVisible = (candidate: ResolvedTranscriptionPlan) => getUiBackendValue(candidate) === "python";
	const pythonModelValues = uniqueStrings([env("MICME_WHISPER_MODEL") ?? "base.en", ...pythonModelCandidates.map((candidate) => candidate.value)]);
	const pythonModelLabels = Object.fromEntries(pythonModelCandidates.map((candidate) => [candidate.value, candidate.label]));
	const modelPathCandidates = [{ label: "Use default model", value: "", description: "Clear explicit path override and use Micme's default whisper.cpp model path.", installed: true, kind: "path" as const }, ...modelCandidates];

	return [
		{
			id: "MICME_AUTO_DOWNLOAD_MODEL",
			categoryId: "general",
			label: "Auto-download models",
			description: "Download missing whisper.cpp models automatically when selected or first used.",
			rawValue: env("MICME_AUTO_DOWNLOAD_MODEL") ?? "1",
			currentValue: env("MICME_AUTO_DOWNLOAD_MODEL") ?? "1",
			values: ["1", "0"],
			displayKind: "boolean",
		},
		{
			id: "MICME_LANGUAGE",
			categoryId: "general",
			label: "Language",
			description: "Use a fixed language for accuracy/speed, or auto for detection.",
			rawValue: env("MICME_LANGUAGE") ?? "en",
			currentValue: env("MICME_LANGUAGE") ?? "en",
			values: ["en", "auto", "bs", "hr", "sr", "de", "es", "fr", "it", "pt", "nl", "pl", "tr"],
			displayKind: "text",
		},
		{
			id: "MICME_TRANSCRIPTION_MODE",
			categoryId: "transcription",
			label: "Transcription mode",
			description: "Changing this applies the matching profile: stable clip defaults or low-latency stream settings.",
			rawValue: getTranscriptionMode(),
			currentValue: getTranscriptionMode(),
			values: ["clip", "stream"],
			displayKind: "text",
		},
		{
			id: "MICME_TRANSCRIBE_BACKEND",
			categoryId: "transcription",
			label: "Backend",
			description: "Choose the transcription backend.",
			rawValue: uiBackendValue,
			currentValue: uiBackendValue,
			values: [...backendValues],
			valueLabels: backendLabels,
			displayKind: "text",
		},
		{
			id: "MICME_WHISPER_CPP_MODEL",
			categoryId: "transcription",
			label: "Model",
			description: "Whisper.cpp ggml/gguf model file.",
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
			label: "Binary",
			description: "Command/path for whisper.cpp transcription. Leave unset to use whisper-cli/whisper-cpp from PATH.",
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
			rawValue: env("MICME_WHISPER_MODEL") ?? "base.en",
			currentValue: env("MICME_WHISPER_MODEL") ?? "base.en",
			values: pythonModelValues,
			valueLabels: pythonModelLabels,
			displayKind: "text",
			visibleWhen: pythonVisible,
		},

		{
			id: "MICME_WHISPER_STREAM_BIN",
			categoryId: "streaming",
			label: "Whisper-stream binary",
			description: "Command/path for whisper-stream. Required when transcription mode is stream.",
			rawValue: env("MICME_WHISPER_STREAM_BIN") ?? "",
			currentValue: displayConfigurationValue("MICME_WHISPER_STREAM_BIN", env("MICME_WHISPER_STREAM_BIN") ?? ""),
			values: whisperStreamBinValues,
			displayKind: "path",
			emptyLabel: "not set",
		},
		{
			id: "MICME_STREAM_CAPTURE",
			categoryId: "streaming",
			label: "Stream capture device",
			description: "whisper-stream/SDL capture id. Use -1 for the system default; ffmpeg device ids may not match.",
			rawValue: env("MICME_STREAM_CAPTURE") ?? "-1",
			currentValue: env("MICME_STREAM_CAPTURE") ?? "-1",
			values: ["-1", "0", "1", "2", "3", "4", "5"],
			displayKind: "number",
		},
		{
			id: "MICME_STREAM_KEEP_CONTEXT",
			categoryId: "streaming",
			label: "Stream context",
			description: "Keep Whisper prompt context between chunks. Off by default for append-only dictation; turn on for more contextual correction.",
			rawValue: env("MICME_STREAM_KEEP_CONTEXT") ?? "0",
			currentValue: env("MICME_STREAM_KEEP_CONTEXT") ?? "0",
			values: ["0", "1"],
			displayKind: "boolean",
		},
		{
			id: "MICME_STREAM_FLUSH_MS",
			categoryId: "streaming",
			label: "Stream flush delay",
			description: "Quiet interval before tentative stream words are committed append-only into the editor.",
			rawValue: env("MICME_STREAM_FLUSH_MS") ?? String(DEFAULT_STREAM_FLUSH_MS),
			currentValue: env("MICME_STREAM_FLUSH_MS") ?? String(DEFAULT_STREAM_FLUSH_MS),
			values: ["400", "650", "700", "1000"],
			displayKind: "number",
		},
		{
			id: "MICME_STREAM_FINALIZE_WITH_CLIP",
			categoryId: "streaming",
			label: "Stream final pass",
			description: "Opt in to replace the append-only live stream with a final clip-mode transcript on stop.",
			rawValue: env("MICME_STREAM_FINALIZE_WITH_CLIP") ?? "0",
			currentValue: env("MICME_STREAM_FINALIZE_WITH_CLIP") ?? "0",
			values: ["0", "1"],
			displayKind: "boolean",
		},
		{
			id: "MICME_STREAM_VAD_THRESHOLD",
			categoryId: "streaming",
			label: "Stream VAD threshold",
			description: "Lower is more sensitive; raise it if background noise causes hallucinations.",
			rawValue: env("MICME_STREAM_VAD_THRESHOLD") ?? String(DEFAULT_STREAM_VAD_THRESHOLD),
			currentValue: env("MICME_STREAM_VAD_THRESHOLD") ?? String(DEFAULT_STREAM_VAD_THRESHOLD),
			values: ["0.35", "0.45", "0.60", "0.75"],
			displayKind: "slider",
		},
		{
			id: "MICME_STREAM_WORDS_PER_CHUNK",
			categoryId: "streaming",
			label: "Stream word chunk",
			description: "Maximum stable words committed per streaming update.",
			rawValue: env("MICME_STREAM_WORDS_PER_CHUNK") ?? "10",
			currentValue: env("MICME_STREAM_WORDS_PER_CHUNK") ?? "10",
			values: ["3", "5", "8", "10"],
			displayKind: "number",
		},
		{
			id: "MICME_AUDIO_DEVICE",
			categoryId: "audio",
			label: "Microphone device",
			description: audioDevices.length > 0 ? "macOS avfoundation audio device id" : "Audio device id/source used by ffmpeg recorder.",
			rawValue: currentDevice,
			currentValue: currentDevice,
			values: audioValues,
			displayKind: "text",
			valueLabels: audioLabels,
		},
		{
			id: "MICME_RECORD_SAMPLE_RATE",
			categoryId: "audio",
			label: "Sample rate override",
			description: "Advanced. Leave auto so ffmpeg uses the selected input's native sample rate.",
			rawValue: env("MICME_RECORD_SAMPLE_RATE") ?? String(DEFAULT_RECORD_SAMPLE_RATE),
			currentValue: env("MICME_RECORD_SAMPLE_RATE") ?? String(DEFAULT_RECORD_SAMPLE_RATE),
			values: ["auto", "48000", "44100", "16000", "96000"],
			displayKind: "text",
		},
		{
			id: "MICME_RECORD_SYNC",
			categoryId: "audio",
			label: "Record timing sync",
			description: "Automatically preserve wall-clock recording duration from ffmpeg timestamps. Keep on unless debugging recorder timing.",
			rawValue: env("MICME_RECORD_SYNC") ?? "1",
			currentValue: env("MICME_RECORD_SYNC") ?? "1",
			values: ["1", "0"],
			displayKind: "boolean",
		},
		{
			id: "MICME_TRANSCRIBE_SAMPLE_RATE",
			categoryId: "audio",
			label: "Transcribe sample rate",
			description: "Sample rate for clip.wav sent to Whisper.",
			rawValue: env("MICME_TRANSCRIBE_SAMPLE_RATE") ?? String(DEFAULT_TRANSCRIBE_SAMPLE_RATE),
			currentValue: env("MICME_TRANSCRIBE_SAMPLE_RATE") ?? String(DEFAULT_TRANSCRIBE_SAMPLE_RATE),
			values: ["16000", "48000", "44100"],
			displayKind: "number",
		},
		{
			id: "MICME_RECORD_METER",
			categoryId: "audio",
			label: "Live meter pipe",
			description: "Stream a second PCM branch from ffmpeg for the waveform meter. Leave off if recordings crackle or sound shortened.",
			rawValue: env("MICME_RECORD_METER") ?? "0",
			currentValue: env("MICME_RECORD_METER") ?? "0",
			values: ["0", "1"],
			displayKind: "boolean",
		},
		...(process.platform === "darwin"
			? [
					{
						id: "MICME_AVFOUNDATION_DROP_LATE_FRAMES",
						categoryId: "audio" as const,
						label: "AVF drop late frames",
						description: "macOS only. Keep off to preserve audio timing when devices or virtual routes lag.",
						rawValue: env("MICME_AVFOUNDATION_DROP_LATE_FRAMES") ?? "0",
						currentValue: env("MICME_AVFOUNDATION_DROP_LATE_FRAMES") ?? "0",
						values: ["0", "1"],
						displayKind: "boolean" as const,
					},
				]
			: []),
		{
			id: "MICME_AUDIO_FILTER",
			categoryId: "audio",
			label: "Audio filter",
			description: "ffmpeg filter for preprocessing. Empty disables filtering while keeping conversion.",
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
			rawValue: env("MICME_METER_GAIN") ?? "1",
			currentValue: env("MICME_METER_GAIN") ?? "1",
			values: ["0.75", "1", "1.5", "2", "3"],
			displayKind: "slider",
		},
		{
			id: "MICME_PROCESS_AUDIO",
			categoryId: "audio",
			label: "Preprocess audio",
			description: "Create a clean 16 kHz clip.wav from raw.wav before transcription.",
			rawValue: env("MICME_PROCESS_AUDIO") ?? "1",
			currentValue: env("MICME_PROCESS_AUDIO") ?? "1",
			values: ["1", "0"],
			displayKind: "boolean",
		},
		{
			id: "MICME_VALIDATE_AUDIO",
			categoryId: "audio",
			label: "Silence guard",
			description: "Reject near-silent clips before Whisper can hallucinate text.",
			rawValue: env("MICME_VALIDATE_AUDIO") ?? "1",
			currentValue: env("MICME_VALIDATE_AUDIO") ?? "1",
			values: ["1", "0"],
			displayKind: "boolean",
		},
		{
			id: "MICME_KEEP_AUDIO",
			categoryId: "audio",
			label: "Keep audio",
			description: "Keep raw.wav and clip.wav under ./micme-rec/rec-###/ after successful transcription for debugging.",
			rawValue: env("MICME_KEEP_AUDIO") ?? "0",
			currentValue: env("MICME_KEEP_AUDIO") ?? "0",
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
			description: "Show opt-in whisper-stream frame/state diagnostics and first-output timing notifications.",
			rawValue: env("MICME_STREAM_DIAGNOSTICS") ?? "0",
			currentValue: env("MICME_STREAM_DIAGNOSTICS") ?? "0",
			values: ["0", "1"],
			displayKind: "boolean",
		},
	];
}

export function createModelSelector(candidates: ModelCandidate[], theme: MicmeTheme, done: (selectedValue?: string) => void): Component {
	const items: SelectItem[] = candidates.map((candidate) => ({
		value: candidate.value,
		label: candidate.installed ? `✓ ${candidate.label}` : `○ ${candidate.label}`,
		description: candidate.description,
	}));

	const container = new Container();
	container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	container.addChild(new Text(theme.fg("accent", theme.bold("Select whisper.cpp model")), 1, 0));
	container.addChild(new Text(theme.fg("dim", "✓ found locally • ○ missing; selecting downloads automatically when enabled"), 1, 0));

	const list = new SelectList(items, Math.min(items.length, 16), {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	});
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done(undefined);
	container.addChild(list);
	container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to search • enter select • esc back"), 1, 0));
	container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

	return {
		render(width: number) {
			return container.render(width);
		},
		invalidate() {
			container.invalidate();
		},
		handleInput(data: string) {
			list.handleInput(data);
		},
	};
}

export async function saveConfigurationValue(ctx: ExtensionContext, id: string, value: string): Promise<Record<string, string>> {
	if (!id.startsWith("MICME_")) return {};

	const valuesToWrite = getConfigurationValuesToWrite(id, value);
	if (id === "MICME_WHISPER_CPP_MODEL" && value) {
		await ensureWhisperCppModel(expandConfigPath(value), ctx);
	}

	await writeMicmeConfigValues(valuesToWrite);
	reloadMicmeConfig();

	const effectiveValues: Record<string, string> = {};
	for (const key of Object.keys(valuesToWrite)) effectiveValues[key] = env(key) ?? "";
	return effectiveValues;
}

export function displayConfigurationValue(id: string, value: string) {
	if (id === "MICME_WHISPER_CPP_MODEL") return value ? basename(value) : "not set";
	if (id === "MICME_TRANSCRIBE_COMMAND") return value ? "configured" : "not set";
	if (id === "MICME_AUDIO_FILTER") return value || "<empty>";
	return value || "not set";
}

function getUiBackendValue(plan: ResolvedTranscriptionPlan): "whisper.cpp" | "python" {
	if (plan.requestedBackend === "python" || plan.requestedBackend === "whisper.cpp") return plan.requestedBackend;
	return plan.effectiveBackend === "python" ? "python" : "whisper.cpp";
}

function getCurrentWhisperCppModelValue() {
	const explicit = env("MICME_WHISPER_CPP_MODEL")?.trim();
	return explicit ? expandConfigPath(explicit) : resolveWhisperCppModel().path;
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
	return { [id]: value };
}

function formatSaveStatus(id: string, value: string) {
	const writtenKeys = Object.keys(getConfigurationValuesToWrite(id, value));
	const overriddenKeys = writtenKeys.filter((key) => process.env[key] !== undefined);
	const reloadHint = id === "MICME_SHORTCUT" ? "/reload required for shortcut changes" : id === "MICME_PRINTABLE_SHORTCUTS" ? "/reload recommended for printable shortcuts" : "";

	if (id === "MICME_TRANSCRIPTION_MODE" && overriddenKeys.length) return `Shell env still overrides ${overriddenKeys.join(", ")}`;
	if (overriddenKeys.length) return reloadHint ? `Shell env still overrides ${overriddenKeys.join(", ")} • ${reloadHint}` : `Shell env still overrides ${overriddenKeys.join(", ")}`;
	return reloadHint;
}

function fitAnsi(text: string, width: number, ellipsis = "…") {
	if (width <= 0) return "";
	return truncateToWidth(text, width, ellipsis);
}

function fitPath(text: string, width: number) {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return fitAnsi(text, width);
	const tail = Array.from(text).slice(-(width - 1)).join("");
	return `…${tail}`;
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

function getShortcutInput(data: string) {
	const parsed = parseKey(data);
	if (parsed && parsed !== "enter" && parsed !== "escape" && parsed !== "esc") return parsed;
	return decodeKittyPrintable(data) ?? getPrintableInput(data);
}

function getPrintableInput(data: string) {
	if (!data || data.includes("\x1b")) return "";
	if (matchesKey(data, Key.space)) return " ";
	if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab) || matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) return "";
	if (/^[^\x00-\x1F\x7F]+$/u.test(data)) return data;
	return "";
}
