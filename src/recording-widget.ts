import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPcm16WaveLevel } from "./audio-level.ts";
import { RECORDING_WIDGET_KEY } from "./constants.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "./terminal-ui.ts";
import type { Capture } from "./transfer/contracts.ts";
import type { Recording } from "./types.ts";

const CAPTURE_LABELS = {
	preparing: "Preparing recorder",
	waiting: "Waiting for samples",
	"opaque-running": "Recorder running; stop to finish",
	samples: "Capturing samples",
	"digital-zero": "Capturing: digital zero",
	"no-speech": "No speech detected",
	processing: "Processing audio",
	"device-failed": "Capture failed; check audio input",
	"asr-failed": "Recognition failed; check model",
	"delivery-failed": "Delivery failed; try /micme last",
} as const satisfies Record<Capture["stage"], string>;

export function captureLabel(stage: Capture["stage"]) { return CAPTURE_LABELS[stage]; }

const LIVE_LABEL = "Live: ";
const MAX_DRAFT_COLUMNS = 160;
const DEFAULT_TERMINAL_COLUMNS = 80;

export class RecordingWidget {
	private timer: ReturnType<typeof setInterval> | undefined;
	private update: (() => void) | undefined;

	start(ctx: ExtensionContext, active: Recording, capture?: () => Capture) {
		this.clear(ctx);
		let displayLevel = 0;
		let lastDraft: string | undefined;
		let lastWidth = 0;
		let draftLine: string | undefined;
		const openFile = active.directory?.openFile.bind(active.directory);
		this.update = () => {
			const elapsedSeconds = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));
			const state = capture?.();
			const sampled = !state || state.stage === "samples" || state.stage === "digital-zero";
			const liveLevel = sampled ? active.audioLevel() : 0;
			const measuredLevel = !sampled || active.livePcmMeter || liveLevel > 0 ? liveLevel : readPcm16WaveLevel(active.audioPath, openFile);
			displayLevel = displayLevel * 0.55 + measuredLevel * 0.45;
			// Pi's TUI pads each string-array line by one column on either side. RPC has no terminal width.
			const width = ctx.mode === "tui" ? Math.max(1, (process.stdout.columns || DEFAULT_TERMINAL_COLUMNS) - 2) : MAX_DRAFT_COLUMNS;
			if (active.liveDraft !== lastDraft || width !== lastWidth) {
				lastDraft = active.liveDraft;
				lastWidth = width;
				draftLine = formatLiveDraft(lastDraft, Math.min(width, MAX_DRAFT_COLUMNS));
			}
			const label = state ? `${state.stage === "opaque-running" ? "Recorder running" : captureLabel(state.stage)} · ` : "";
			const line = truncateToWidth(label + formatRecordingWidgetLine(ctx, elapsedSeconds, displayLevel, sampled), width, "");
			const lines = draftLine ? [line, draftLine] : [line];
			if (state) lines.push(truncateToWidth(formatCaptureInput(state), width, "…"));
			ctx.ui.setWidget(RECORDING_WIDGET_KEY, lines);
		};
		this.update();
		this.timer = setInterval(this.update, 120);
	}

	refresh() { this.update?.(); }

	clear(ctx: ExtensionContext) {
		clearInterval(this.timer);
		this.timer = undefined;
		this.update = undefined;
		ctx.ui.setWidget(RECORDING_WIDGET_KEY, undefined);
	}
}

function formatLiveDraft(draft: string | undefined, width: number) {
	if (!draft || width <= LIVE_LABEL.length) return undefined;
	const clean = sanitizeTerminalText(draft.replace(/\p{Bidi_Control}/gu, ""));
	return clean ? LIVE_LABEL + fitTerminalTail(clean, width - LIVE_LABEL.length, true) : undefined;
}

/** Fit an already sanitized line, preserving its right edge and whole graphemes. */
export function fitTerminalTail(text: string, width: number, wholeWords = false) {
	if (width <= 0) return "";
	const textWidth = visibleWidth(text);
	if (textWidth <= width) return text;
	const tail = sliceByColumn(text, textWidth - width + 1, width - 1, true);
	const cut = text.length - tail.length;
	const startsMidWord = cut > 0 && !/\s/u.test(text[cut - 1]!) && /^\S/u.test(tail);
	return `…${(wholeWords && startsMidWord ? tail.replace(/^\S+\s+(?=\S)/u, "") : tail).trimStart()}`;
}

function formatCaptureInput(state: Capture) {
	const actual = state.actual === null ? "Device unknown" : `Device: ${sanitizeTerminalText(state.actual.replace(/\p{Bidi_Control}/gu, ""))}`;
	const channel = state.channel === null ? "channel unknown" : `channel ${state.channel}`;
	const requested = state.requested === null ? "" : ` · Requested: ${sanitizeTerminalText(state.requested.replace(/\p{Bidi_Control}/gu, ""))}`;
	return `${state.source === "custom" ? "Custom · " : ""}${actual}, ${channel}${state.fallback ? " · fallback" : ""}${requested}`;
}

export function formatRecordingWidgetLine(ctx: ExtensionContext, elapsedSeconds: number, audioLevel: number, sampled = true) {
	const dot = sampled ? ctx.ui.theme.fg("error", "●") : ctx.ui.theme.fg("muted", "○");
	const time = ctx.ui.theme.fg("accent", formatElapsedTime(elapsedSeconds));
	const wave = ctx.ui.theme.fg("muted", recordingWaveformFrame(audioLevel));
	return `${dot} ${time}  ${wave}`;
}

export function recordingWaveformFrame(audioLevel: number) {
	const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const width = 13;
	const phase = Math.floor(Date.now() / 250) % width;
	const level = Math.max(0, Math.min(1, audioLevel));
	if (level < 0.02) return bars[0].repeat(width);

	let output = "";
	for (let index = 0; index < width; index++) {
		const x = ((index + phase) % width) / (width - 1);
		const envelope = Math.sin(Math.PI * x);
		const shaped = Math.max(0.06, envelope) * level;
		const barIndex = Math.max(0, Math.min(bars.length - 1, Math.round(shaped * (bars.length - 1))));
		output += bars[barIndex];
	}
	return output;
}

export function formatElapsedTime(totalSeconds: number) {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
