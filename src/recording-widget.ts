import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RECORDING_WIDGET_KEY } from "./constants.ts";
import { readPcm16WaveLevel } from "./audio-level.ts";
import type { Recording } from "./types.ts";

let recordingWidgetTimer: ReturnType<typeof setInterval> | undefined;

export function startRecordingWidget(ctx: ExtensionContext, active: Recording) {
	clearRecordingWidget(ctx);
	let displayLevel = 0;
	const update = () => {
		const elapsedSeconds = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));
		const liveLevel = active.audioLevel();
		const measuredLevel = liveLevel > 0 ? liveLevel : readPcm16WaveLevel(active.audioPath);
		displayLevel = displayLevel * 0.55 + measuredLevel * 0.45;
		const line = formatRecordingWidgetLine(ctx, elapsedSeconds, displayLevel);
		ctx.ui.setWidget(RECORDING_WIDGET_KEY, [line]);
	};
	update();
	recordingWidgetTimer = setInterval(update, 120);
}

export function clearRecordingWidget(ctx?: ExtensionContext) {
	if (recordingWidgetTimer) {
		clearInterval(recordingWidgetTimer);
		recordingWidgetTimer = undefined;
	}
	ctx?.ui.setWidget(RECORDING_WIDGET_KEY, undefined);
}

export function formatRecordingWidgetLine(ctx: ExtensionContext, elapsedSeconds: number, audioLevel: number) {
	const dot = ctx.ui.theme.fg("error", "●");
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
