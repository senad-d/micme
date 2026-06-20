import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { AUDIO_VALIDATION_TIMEOUT_MS } from "./constants.ts";
import { env, envFlag, getAudioFilter, getAvfoundationDropLateFrames, getAvfoundationInputSampleRate, getMinMaxVolumeDb, getRecordMeter, getRecordSampleRate, getRecordSync, getTranscribeSampleRate } from "./config.ts";
import { findExecutable, formatRunExit, replacePlaceholders, runProcess, shellCommand, shellQuote } from "./processes.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import type { AudioDeviceCandidate, AudioDiagnostics, CommandSpec, RunResult } from "./types.ts";

type DeviceBackend = "avfoundation" | "pulse" | "dshow" | "unsupported";
type DeviceKind = "audio" | "video";

type ListedDevice = {
	id?: string;
	name: string;
};

type ParsedDeviceInventory = {
	audio: ListedDevice[];
	video: ListedDevice[];
	sawDeviceSection: boolean;
};

type DeviceBackendInfo =
	| {
			backend: Exclude<DeviceBackend, "unsupported">;
			sourceLabel: string;
			args: string[];
			includeVideo: boolean;
	  }
	| {
			backend: "unsupported";
			sourceLabel: string;
			includeVideo: false;
	  };

type DevicePanelOptions = {
	sourceLabel: string;
	backend: DeviceBackend;
	audio?: ListedDevice[];
	video?: ListedDevice[];
	includeVideo?: boolean;
	warning?: string;
	errorLines?: string[];
};

type DevicePanelStyle = {
	plain: boolean;
	separator: string;
	audioLabel: string;
	videoLabel: string;
	warningLabel: string;
	errorLabel: string;
	ellipsis: string;
};

const DEVICE_SCAN_TIMEOUT_MS = 8_000;
const DEVICE_PANEL_MESSAGE_TYPE = "micme-devices";
const DEVICE_PANEL_DEFAULT_WIDTH = 92;
const DEVICE_PANEL_MAX_WIDTH = 100;
const DEVICE_PANEL_MIN_WIDTH = 36;
const RECORD_TIMING_SYNC_FILTER = "aresample=async=1:first_pts=0";

let deviceMessageRendererRegistered = false;

type DevicePanelMessage = {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
};

type DeviceMessageRendererOptions = {
	expanded?: boolean;
};

type DeviceMessageApi = {
	registerMessageRenderer?: (
		customType: string,
		renderer: (message: DevicePanelMessage, options: DeviceMessageRendererOptions, theme: ExtensionContext["ui"]["theme"]) => Component,
	) => void;
	sendMessage?: (message: DevicePanelMessage, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) => void;
};

export function registerDeviceMessageRenderer(pi: ExtensionAPI) {
	const api = pi as ExtensionAPI & DeviceMessageApi;
	if (!api.registerMessageRenderer) return;
	api.registerMessageRenderer(DEVICE_PANEL_MESSAGE_TYPE, (message) => new DevicePanelMessageComponent(readDevicePanelOptions(message.details)));
	deviceMessageRendererRegistered = true;
}

export async function listAudioDevices(ctx: ExtensionContext, pi?: ExtensionAPI) {
	const backend = getCurrentDeviceBackend();
	if (backend.backend === "unsupported") {
		await showDevicePanel(ctx, pi, {
			sourceLabel: backend.sourceLabel,
			backend: backend.backend,
			errorLines: ["Device listing is not implemented for this platform"],
		});
		return;
	}

	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) {
		await showDevicePanel(ctx, pi, {
			sourceLabel: backend.sourceLabel,
			backend: backend.backend,
			errorLines: ["ffmpeg not found", "Install ffmpeg or configure a custom recorder before listing devices."],
		});
		return;
	}

	let result: RunResult;
	try {
		result = await runProcess(ffmpeg, backend.args, DEVICE_SCAN_TIMEOUT_MS);
	} catch {
		await showDevicePanel(ctx, pi, {
			sourceLabel: backend.sourceLabel,
			backend: backend.backend,
			errorLines: ["Device scan failed", "Could not start ffmpeg to list capture devices."],
		});
		return;
	}

	await showDevicePanel(ctx, pi, buildDevicePanelFromRun(backend, result));
}

function getCurrentDeviceBackend(): DeviceBackendInfo {
	if (process.platform === "darwin") {
		return {
			backend: "avfoundation",
			sourceLabel: "macOS · AVF",
			args: ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
			includeVideo: true,
		};
	}

	if (process.platform === "linux") {
		return {
			backend: "pulse",
			sourceLabel: "Linux · Pulse",
			args: ["-hide_banner", "-sources", "pulse"],
			includeVideo: false,
		};
	}

	if (process.platform === "win32") {
		return {
			backend: "dshow",
			sourceLabel: "Windows · DShow",
			args: ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
			includeVideo: true,
		};
	}

	return { backend: "unsupported", sourceLabel: `${process.platform} · unsupported`, includeVideo: false };
}

function buildDevicePanelFromRun(backend: Extract<DeviceBackendInfo, { args: string[] }>, result: RunResult): DevicePanelOptions {
	const output = combineRunOutput(result);
	const parsed = parseDeviceInventory(backend.backend, output);
	const hasDevices = parsed.audio.length > 0 || parsed.video.length > 0;

	if (result.timedOut) {
		return {
			sourceLabel: backend.sourceLabel,
			backend: backend.backend,
			errorLines: ["Device scan timed out", "FFmpeg did not return device information within 8s."],
		};
	}

	if (!hasDevices && backend.backend === "avfoundation" && hasMacosPermissionIssue(output)) {
		return {
			sourceLabel: backend.sourceLabel,
			backend: backend.backend,
			errorLines: ["macOS microphone permission may be blocked", "Allow microphone access for the terminal app, then try again."],
		};
	}

	if (!hasDevices && result.code !== 0) {
		return {
			sourceLabel: backend.sourceLabel,
			backend: backend.backend,
			audio: parsed.audio,
			video: parsed.video,
			includeVideo: backend.includeVideo,
			errorLines: [getNoParseableDeviceMessage(backend.backend)],
		};
	}

	return {
		sourceLabel: backend.sourceLabel,
		backend: backend.backend,
		audio: parsed.audio,
		video: parsed.video,
		includeVideo: backend.includeVideo,
		warning: getDeviceScanWarning(backend.backend, result, output, hasDevices),
	};
}

function combineRunOutput(result: RunResult) {
	return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function parseDeviceInventory(backend: Exclude<DeviceBackend, "unsupported">, output: string): ParsedDeviceInventory {
	if (backend === "avfoundation") return parseAvfoundationDevices(output);
	if (backend === "pulse") return parsePulseAudioDevices(output);
	return parseDirectShowDevices(output);
}

export function parseAvfoundationDevices(output: string): ParsedDeviceInventory {
	const inventory: ParsedDeviceInventory = { audio: [], video: [], sawDeviceSection: false };
	let section: DeviceKind | undefined;

	for (const line of output.split(/\r?\n/)) {
		if (line.includes("AVFoundation video devices:")) {
			section = "video";
			inventory.sawDeviceSection = true;
			continue;
		}
		if (line.includes("AVFoundation audio devices:")) {
			section = "audio";
			inventory.sawDeviceSection = true;
			continue;
		}
		if (!section) continue;

		const match = line.match(/\[(\d+)\]\s+(.+)$/);
		if (!match) continue;
		const id = sanitizeDeviceField(match[1] ?? "");
		const name = sanitizeDeviceField(match[2] ?? "");
		if (!name) continue;
		inventory[section].push({ id, name });
	}

	return inventory;
}

function parsePulseAudioDevices(output: string): ParsedDeviceInventory {
	const inventory: ParsedDeviceInventory = { audio: [], video: [], sawDeviceSection: false };
	let inSources = false;

	for (const rawLine of output.split(/\r?\n/)) {
		const line = stripFfmpegLogPrefix(rawLine).trim();
		if (/Auto-detected sources for pulse|sources for pulse/i.test(line)) {
			inSources = true;
			inventory.sawDeviceSection = true;
			continue;
		}
		if (!inSources || !line || /^(Cannot|Error|Failed|Unknown)\b/i.test(line)) continue;

		const sourceLine = line.replace(/^\*\s*/, "");
		const match = sourceLine.match(/^([^\s\[]+)(?:\s+\[(.+)\])?$/);
		if (!match) continue;
		const id = sanitizeDeviceField(match[1] ?? "");
		if (!id || id.includes(":")) continue;
		let name = sanitizeDeviceField(match[2] ?? "");
		if (id === "default" && (!name || /^default$/i.test(name))) name = "PulseAudio default source";
		inventory.audio.push({ id, name });
	}

	return inventory;
}

function parseDirectShowDevices(output: string): ParsedDeviceInventory {
	const inventory: ParsedDeviceInventory = { audio: [], video: [], sawDeviceSection: false };
	let section: DeviceKind | undefined;

	for (const rawLine of output.split(/\r?\n/)) {
		const line = stripFfmpegLogPrefix(rawLine).trim();
		if (/DirectShow video devices/i.test(line)) {
			section = "video";
			inventory.sawDeviceSection = true;
			continue;
		}
		if (/DirectShow audio devices/i.test(line)) {
			section = "audio";
			inventory.sawDeviceSection = true;
			continue;
		}
		if (!section || /Alternative name/i.test(line)) continue;

		const match = line.match(/^"(.+)"$/) ?? line.match(/"([^"]+)"/);
		const name = sanitizeDeviceField(match?.[1] ?? "");
		if (!name) continue;
		inventory[section].push({ name });
	}

	return inventory;
}

function stripFfmpegLogPrefix(line: string) {
	return line.replace(/^(?:\[[^\]]+\]\s*)+/, "");
}

function sanitizeDeviceField(value: string) {
	return sanitizeTerminalText(value);
}

function hasMacosPermissionIssue(output: string) {
	return /(?:not authorized|authorization|privacy|permission|operation not permitted|microphone access|access.*microphone|microphone.*blocked)/i.test(output);
}

function getDeviceScanWarning(backend: Exclude<DeviceBackend, "unsupported">, result: RunResult, output: string, hasDevices: boolean) {
	if (!hasDevices) return undefined;
	if (backend === "avfoundation" && hasAvfoundationIoWarning(output)) return "AVFoundation I/O warning after scan";
	if (backend === "dshow" && /Immediate exit requested/i.test(output)) return undefined;
	if (result.code !== 0 || result.signal) return `${getBackendLongName(backend)} warning after scan`;
	if (hasFfmpegWarningAfterScan(output)) return `${getBackendLongName(backend)} warning after scan`;
	return undefined;
}

function hasAvfoundationIoWarning(output: string) {
	return /(?:Input\/output error|I\/O error|Error opening input|Error opening input file|Error opening input files)/i.test(output);
}

function hasFfmpegWarningAfterScan(output: string) {
	return /\b(?:warning|error|failed|cannot|unable)\b/i.test(output);
}

function getNoParseableDeviceMessage(backend: Exclude<DeviceBackend, "unsupported">) {
	if (backend === "avfoundation") return "No parseable AVFoundation device output";
	if (backend === "pulse") return "No parseable PulseAudio source output";
	return "No parseable DirectShow device output";
}

function getBackendLongName(backend: Exclude<DeviceBackend, "unsupported">) {
	if (backend === "avfoundation") return "AVFoundation";
	if (backend === "pulse") return "PulseAudio";
	return "DirectShow";
}

async function showDevicePanel(ctx: ExtensionContext, pi: ExtensionAPI | undefined, options: DevicePanelOptions) {
	if (sendDevicePanelMessage(pi, options)) return;
	ctx.ui.setWidget(DEVICE_PANEL_MESSAGE_TYPE, renderDevicePanel(options).split("\n"));
}

function sendDevicePanelMessage(pi: ExtensionAPI | undefined, options: DevicePanelOptions) {
	const api = pi as (ExtensionAPI & DeviceMessageApi) | undefined;
	if (!deviceMessageRendererRegistered || !api?.sendMessage) return false;
	api.sendMessage({ customType: DEVICE_PANEL_MESSAGE_TYPE, content: "Micme devices", display: true, details: options });
	return true;
}

class DevicePanelMessageComponent implements Component {
	private readonly options: DevicePanelOptions;

	constructor(options: DevicePanelOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		return renderDevicePanel(this.options, Math.min(width, DEVICE_PANEL_MAX_WIDTH)).split("\n");
	}

	invalidate(): void {}
}

function readDevicePanelOptions(value: unknown): DevicePanelOptions {
	if (!isDevicePanelOptions(value)) {
		return {
			sourceLabel: "unknown · unsupported",
			backend: "unsupported",
			errorLines: ["Could not render Micme devices panel"],
		};
	}
	return value;
}

function isDevicePanelOptions(value: unknown): value is DevicePanelOptions {
	if (!value || typeof value !== "object") return false;
	const candidate = value as DevicePanelOptions;
	return typeof candidate.sourceLabel === "string" && isDeviceBackend(candidate.backend);
}

function isDeviceBackend(value: unknown): value is DeviceBackend {
	return value === "avfoundation" || value === "pulse" || value === "dshow" || value === "unsupported";
}

export function renderDevicePanel(options: DevicePanelOptions, width = getDevicePanelWidth()) {
	const style = getDevicePanelStyle();
	const panelWidth = Math.max(2, Math.floor(width));
	const lines = [buildDevicePanelHeader(panelWidth, options.sourceLabel, style)];
	const hasInventory = options.audio !== undefined || options.video !== undefined || !options.errorLines?.length;

	if (hasInventory) {
		lines.push(buildDeviceRow("audio", options.audio ?? [], style, panelWidth));
		if (options.includeVideo) lines.push(buildDeviceRow("video", options.video ?? [], style, panelWidth));
	}

	if (options.warning) lines.push(buildStatusRow("warning", options.warning, style, panelWidth));
	for (const [index, line] of (options.errorLines ?? []).entries()) {
		lines.push(buildErrorRow(line, index === 0, style, panelWidth));
	}
	lines.push(buildDevicePanelFooter(panelWidth, style));

	return lines.filter(Boolean).join("\n");
}

function getDevicePanelWidth() {
	const columns = process.stdout.columns;
	if (Number.isFinite(columns) && columns > 0) {
		const capped = Math.min(columns, DEVICE_PANEL_MAX_WIDTH);
		return capped < DEVICE_PANEL_MIN_WIDTH ? Math.max(2, capped) : capped;
	}
	return DEVICE_PANEL_DEFAULT_WIDTH;
}

function getDevicePanelStyle(): DevicePanelStyle {
	const plain = shouldUsePlainDevicePanel();
	return {
		plain,
		separator: plain ? " | " : " │ ",
		audioLabel: plain ? "audio" : "🎙",
		videoLabel: plain ? "video" : "🎥",
		warningLabel: plain ? "warn" : "⚠",
		errorLabel: plain ? "error" : "✕",
		ellipsis: plain ? "..." : "…",
	};
}

function shouldUsePlainDevicePanel() {
	const locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].filter(Boolean).join(" ");
	return envFlag("MICME_PLAIN") || envFlag("MICME_ASCII") || envFlag("MICME_NO_UNICODE") || process.env.TERM === "dumb" || (locale.length > 0 && !/utf-?8/i.test(locale));
}

function formatSourceLabel(sourceLabel: string, style: DevicePanelStyle) {
	return style.plain ? sourceLabel.replace(/\s*·\s*/g, " - ") : sourceLabel;
}

function buildDevicePanelHeader(width: number, sourceLabel: string, style: DevicePanelStyle) {
	const title = "Micme devices";
	if (width < 18) return fitLine(style.plain ? `+-- ${title}` : `╭─ ${title}`, width, style);

	const overhead = style.plain ? 10 : 8;
	const availableTextWidth = Math.max(1, width - overhead - 1);
	const sourceBudget = Math.max(4, Math.min(visibleWidth(sourceLabel), Math.floor(availableTextWidth * 0.45)));
	let source = ellipsize(formatSourceLabel(sourceLabel, style), sourceBudget, style);
	let titleText = ellipsize(title, Math.max(4, availableTextWidth - visibleWidth(source)), style);
	if (visibleWidth(titleText) + visibleWidth(source) > availableTextWidth) {
		source = ellipsize(source, Math.max(1, availableTextWidth - visibleWidth(titleText)), style);
	}

	const fillerWidth = Math.max(1, width - overhead - visibleWidth(titleText) - visibleWidth(source));
	const filler = (style.plain ? "-" : "─").repeat(fillerWidth);
	return style.plain ? `+-- ${titleText} ${filler} ${source} --+` : `╭─ ${titleText} ${filler} ${source} ─╮`;
}

function buildDevicePanelFooter(width: number, style: DevicePanelStyle) {
	if (width < 2) return style.plain ? "+" : "╰";
	const horizontal = (style.plain ? "-" : "─").repeat(Math.max(0, width - 2));
	return style.plain ? `+${horizontal}+` : `╰${horizontal}╯`;
}

function buildDeviceRow(kind: DeviceKind, devices: ListedDevice[], style: DevicePanelStyle, width: number) {
	const prefix = style.plain ? `  ${kind.padEnd(5)} ${devices.length}` : `  ${kind === "audio" ? style.audioLabel : style.videoLabel} ${devices.length}`;
	if (devices.length === 0) return fitLine(`${prefix}${style.separator}no ${kind} devices found`, width, style);

	const displayNames = compactDeviceNames(devices);
	let row = prefix;
	let shown = 0;

	for (let index = 0; index < devices.length; index++) {
		const remainingAfter = devices.length - index - 1;
		const overflow = remainingAfter > 0 ? `${style.separator}+${remainingAfter} more` : "";
		const chip = formatDeviceChip(devices[index]!, displayNames[index]!);
		const candidate = `${row}${style.separator}${chip}${overflow}`;
		if (visibleWidth(candidate) <= width) {
			row = `${row}${style.separator}${chip}`;
			shown = index + 1;
			continue;
		}

		const availableForChip = width - visibleWidth(`${row}${style.separator}${overflow}`);
		if (availableForChip >= getMinimumDeviceChipWidth(devices[index]!)) {
			row = `${row}${style.separator}${truncateDeviceChip(devices[index]!, displayNames[index]!, availableForChip, style)}`;
			shown = index + 1;
		}
		break;
	}

	const hidden = devices.length - shown;
	if (hidden > 0) {
		const overflow = `${style.separator}+${hidden} more`;
		if (visibleWidth(`${row}${overflow}`) <= width) row = `${row}${overflow}`;
	}

	return fitLine(row, width, style);
}

function buildStatusRow(kind: "warning", message: string, style: DevicePanelStyle, width: number) {
	if (style.plain) return fitLine(`  ${style.warningLabel.padEnd(7)}${style.separator}${message}`, width, style);
	return fitLine(`  ${kind === "warning" ? style.warningLabel : "✓"} ${message}`, width, style);
}

function buildErrorRow(message: string, primary: boolean, style: DevicePanelStyle, width: number) {
	if (style.plain) return fitLine(`  ${(primary ? style.errorLabel : "").padEnd(7)}${style.separator}${message}`, width, style);
	return fitLine(primary ? `  ${style.errorLabel} ${message}` : `  ${message}`, width, style);
}

function compactDeviceNames(devices: ListedDevice[]) {
	const originals = devices.map((device) => device.name || (device.id ? "" : "unknown"));
	const proposed = originals.map((name) => (name ? compactLowValueDevicePrefix(name) : ""));
	const counts = new Map<string, number>();
	for (const name of proposed) {
		if (name) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
	}
	return devices.map((device, index) => {
		const compacted = proposed[index] || originals[index] || "";
		if (compacted !== device.name && compacted && counts.get(compacted.toLowerCase()) === 1) return compacted;
		return originals[index] || "";
	});
}

function compactLowValueDevicePrefix(name: string) {
	return name
		.replace(/^Microsoft\s+Teams\s+Audio$/i, "Teams Audio")
		.replace(/^Microsoft\s+Teams\b/i, "Teams")
		.replace(/^Microsoft\s+/i, "")
		.trim();
}

function formatDeviceChip(device: ListedDevice, displayName: string) {
	const id = device.id?.trim();
	if (!id) return displayName;
	return displayName ? `${id} ${displayName}` : id;
}

function truncateDeviceChip(device: ListedDevice, displayName: string, width: number, style: DevicePanelStyle) {
	const id = device.id?.trim();
	if (!id) return ellipsize(displayName, width, style);
	if (visibleWidth(id) >= width) return ellipsize(id, width, style);
	const prefix = `${id} `;
	const nameWidth = width - visibleWidth(prefix);
	if (nameWidth <= 0) return id;
	return `${prefix}${ellipsize(displayName, nameWidth, style)}`;
}

function getMinimumDeviceChipWidth(device: ListedDevice) {
	const id = device.id?.trim();
	if (id) return device.name ? visibleWidth(id) + 2 : visibleWidth(id);
	return Math.min(4, Math.max(1, visibleWidth(device.name || "unknown")));
}

function fitLine(line: string, width: number, style: DevicePanelStyle) {
	return visibleWidth(line) <= width ? line : ellipsize(line, width, style);
}

function ellipsize(value: string, width: number, style: DevicePanelStyle) {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	const ellipsisWidth = visibleWidth(style.ellipsis);
	if (width <= ellipsisWidth) return sliceByColumn(style.ellipsis, 0, width) || ".".repeat(width);
	let truncated = sliceByColumn(value, 0, width - ellipsisWidth).trimEnd();
	while (truncated && visibleWidth(`${truncated}${style.ellipsis}`) > width) {
		truncated = sliceByColumn(truncated, 0, Math.max(0, visibleWidth(truncated) - 1)).trimEnd();
	}
	return `${truncated || sliceByColumn(value, 0, Math.max(0, width - ellipsisWidth))}${style.ellipsis}`;
}

export async function discoverAudioDevices(): Promise<AudioDeviceCandidate[]> {
	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) return [];

	if (process.platform === "darwin") {
		const result = await runProcess(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], DEVICE_SCAN_TIMEOUT_MS);
		return parseAvfoundationAudioDevices(`${result.stdout}\n${result.stderr}`);
	}

	if (process.platform === "linux") {
		return [{ label: "default", value: "default", description: "PulseAudio default source" }];
	}

	if (process.platform === "win32") {
		return [{ label: "default", value: "default", description: "DirectShow default audio input" }];
	}

	return [];
}

export function parseAvfoundationAudioDevices(output: string): AudioDeviceCandidate[] {
	return parseAvfoundationDevices(output).audio.map((device) => ({
		label: `${device.id ?? ""}: ${device.name}`,
		value: device.id ?? "",
		description: device.name,
	}));
}

export async function prepareAudioForTranscription(inputPath: string, tempDir: string) {
	if (env("MICME_PROCESS_AUDIO") === "0") return inputPath;

	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) return inputPath;

	const outputPath = join(tempDir, "clip.wav");
	const filter = getAudioFilter();
	const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath];
	if (filter) args.push("-af", filter);
	args.push("-ac", "1", "-ar", String(getTranscribeSampleRate()), "-c:a", "pcm_s16le", outputPath);

	const result = await runProcess(ffmpeg, args, AUDIO_VALIDATION_TIMEOUT_MS);
	if (result.code !== 0) {
		throw new Error(`Micme audio preprocessing failed (${formatRunExit(result)}):\n${result.stderr || result.stdout}`);
	}

	return outputPath;
}

export async function validateRecordedAudio(audioPath: string): Promise<AudioDiagnostics | undefined> {
	if (env("MICME_VALIDATE_AUDIO") === "0" || envFlag("MICME_SKIP_AUDIO_VALIDATION")) return undefined;

	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) return undefined;

	const result = await runProcess(ffmpeg, ["-hide_banner", "-nostats", "-i", audioPath, "-af", "volumedetect", "-f", "null", "-"], AUDIO_VALIDATION_TIMEOUT_MS);
	const raw = `${result.stdout}\n${result.stderr}`.trim();
	if (result.code !== 0) {
		throw new Error(`Micme could not inspect recorded audio (${formatRunExit(result)}):\n${raw}`);
	}

	const diagnostics: AudioDiagnostics = {
		meanVolumeDb: parseVolumeDb(raw, "mean_volume"),
		maxVolumeDb: parseVolumeDb(raw, "max_volume"),
		raw,
	};

	const minimumMaxVolumeDb = getMinMaxVolumeDb();
	if (diagnostics.maxVolumeDb !== undefined && diagnostics.maxVolumeDb < minimumMaxVolumeDb) {
		throw new Error(
			`Micme recorded almost-silent audio (max ${diagnostics.maxVolumeDb.toFixed(1)} dB; threshold ${minimumMaxVolumeDb.toFixed(1)} dB). ` +
				"Whisper often hallucinates phrases like 'Thank you very much' from silence. " +
				"Run /micme devices and set MICME_AUDIO_DEVICE to the real microphone, or set MICME_VALIDATE_AUDIO=0 to bypass this check.",
		);
	}

	return diagnostics;
}

export function parseVolumeDb(output: string, label: "mean_volume" | "max_volume") {
	const match = output.match(new RegExp(`${label}:\\s*(-?(?:\\d+(?:\\.\\d+)?|inf))\\s*dB`, "i"));
	if (!match) return undefined;
	return match[1]?.toLowerCase() === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

export function buildRecorderCommand(audioPath: string): CommandSpec {
	const custom = env("MICME_RECORD_COMMAND");
	if (custom?.trim()) {
		const expanded = replacePlaceholders(custom, { audio: audioPath });
		return shellCommand(expanded);
	}

	const ffmpeg = findExecutable(["ffmpeg"]);
	if (!ffmpeg) {
		throw new Error("Micme needs ffmpeg for recording, or set MICME_RECORD_COMMAND.");
	}

	const recordSampleRate = getRecordSampleRate()?.toString();
	const recordMeter = getRecordMeter();
	const recordSync = getRecordSync();
	const timingFilters = recordSync ? [RECORD_TIMING_SYNC_FILTER] : [];

	if (process.platform === "darwin") {
		const input = env("MICME_AVFOUNDATION_INPUT") || `:${env("MICME_AUDIO_DEVICE") || "0"}`;
		const avfoundationInputSampleRate = getAvfoundationInputSampleRate();
		const args = buildFfmpegRecorderArgs("avfoundation", input, audioPath, recordSampleRate, {
			meter: recordMeter,
			inputOptions: ["-drop_late_frames", getAvfoundationDropLateFrames() ? "true" : "false"],
			audioFilters: recordSync ? timingFilters : avfoundationInputSampleRate ? [`asetrate=${avfoundationInputSampleRate}`] : [],
		});
		return { command: ffmpeg, args, display: `${ffmpeg} ${args.map(shellQuote).join(" ")}`, meterFromStdout: recordMeter, stopInput: "q\n" };
	}

	if (process.platform === "linux") {
		const input = env("MICME_PULSE_SOURCE") || "default";
		const args = buildFfmpegRecorderArgs("pulse", input, audioPath, recordSampleRate, { meter: recordMeter, audioFilters: timingFilters });
		return { command: ffmpeg, args, display: `${ffmpeg} ${args.map(shellQuote).join(" ")}`, meterFromStdout: recordMeter, stopInput: "q\n" };
	}

	if (process.platform === "win32") {
		const input = `audio=${env("MICME_DSHOW_AUDIO_DEVICE") || "default"}`;
		const args = buildFfmpegRecorderArgs("dshow", input, audioPath, recordSampleRate, { meter: recordMeter, audioFilters: timingFilters });
		return { command: ffmpeg, args, display: `${ffmpeg} ${args.map(shellQuote).join(" ")}`, meterFromStdout: recordMeter, stopInput: "q\n" };
	}

	throw new Error(`Micme has no default recorder for ${process.platform}. Set MICME_RECORD_COMMAND.`);
}

type FfmpegRecorderOptions = {
	meter?: boolean;
	inputOptions?: string[];
	audioFilters?: string[];
};

export function buildFfmpegRecorderArgs(inputFormat: string, input: string, audioPath: string, recordSampleRate: string | undefined, options: FfmpegRecorderOptions = {}) {
	const inputArgs = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-thread_queue_size",
		"4096",
		"-f",
		inputFormat,
		...(options.inputOptions ?? []),
		"-i",
		input,
	];
	const fileOutputArgs = ["-ac", "1", ...formatOptionalSampleRateArgs(recordSampleRate), "-c:a", "pcm_s16le", "-vn", "-y", audioPath];
	const audioFilters = (options.audioFilters ?? []).filter(Boolean);

	if (options.meter === false && audioFilters.length === 0) {
		return [...inputArgs, "-map", "0:a:0", ...fileOutputArgs];
	}

	if (options.meter === false) {
		return [...inputArgs, "-filter_complex", buildFileOnlyAudioFilterGraph(audioFilters), "-map", "[micme_file]", ...fileOutputArgs];
	}

	return [
		...inputArgs,
		"-filter_complex",
		buildMeteredAudioFilterGraph(audioFilters),
		"-map",
		"[micme_file]",
		...fileOutputArgs,
		"-map",
		"[micme_meter]",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-f",
		"s16le",
		"pipe:1",
	];
}

export function buildMeteredFfmpegRecorderArgs(inputFormat: string, input: string, audioPath: string, recordSampleRate: string | undefined) {
	return buildFfmpegRecorderArgs(inputFormat, input, audioPath, recordSampleRate, { meter: true });
}

function formatOptionalSampleRateArgs(recordSampleRate: string | undefined) {
	return recordSampleRate ? ["-ar", recordSampleRate] : [];
}

function buildFileOnlyAudioFilterGraph(audioFilters: string[]) {
	return audioFilters.length > 0 ? `[0:a]${audioFilters.join(",")}[micme_file]` : "[0:a]anull[micme_file]";
}

function buildMeteredAudioFilterGraph(audioFilters: string[]) {
	const prefix = audioFilters.length > 0 ? `${audioFilters.join(",")},` : "";
	return `[0:a]${prefix}asplit=2[micme_file][micme_meter]`;
}
