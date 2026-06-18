import { closeSync, openSync, readSync, statSync } from "node:fs";
import { getMeterFloorDb, getMeterGain, getMeterPeakFloorDb, getMeterRangeDb } from "./config.ts";

export function readPcm16WaveLevel(path: string) {
	try {
		const stats = statSync(path);
		if (stats.size <= 44) return 0;

		const maxBytes = 48_000;
		const start = Math.max(44, stats.size - maxBytes);
		const length = Math.max(0, stats.size - start);
		if (length < 2) return 0;

		const buffer = Buffer.alloc(length - (length % 2));
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, buffer.length, start);
		} finally {
			closeSync(fd);
		}

		return pcm16BufferLevel(buffer);
	} catch {
		return 0;
	}
}

export function pcm16BufferLevel(buffer: Buffer) {
	let sumSquares = 0;
	let peak = 0;
	const samples = Math.floor(buffer.length / 2);
	if (samples <= 0) return 0;

	for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
		const sample = buffer.readInt16LE(offset) / 32768;
		const abs = Math.abs(sample);
		if (abs > peak) peak = abs;
		sumSquares += sample * sample;
	}

	const rms = Math.sqrt(sumSquares / samples);
	if (!Number.isFinite(rms) || rms <= 0) return 0;

	const rmsDb = 20 * Math.log10(rms);
	const peakDb = peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
	const rmsLevel = (rmsDb + getMeterFloorDb()) / getMeterRangeDb();
	const peakLevel = (peakDb + getMeterPeakFloorDb()) / getMeterRangeDb();
	const level = Math.max(rmsLevel, peakLevel * 0.8) * getMeterGain();
	return Math.max(0, Math.min(1, level));
}

