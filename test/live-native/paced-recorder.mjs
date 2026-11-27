import assert from "node:assert/strict";
import { appendFileSync, closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { setInterval as ticks } from "node:timers/promises";
import { RATE, wavHeader } from "./corpus.mjs";

const [, , output, source, trace] = process.argv;
const wave = readFileSync(source);
const pcm = wave.subarray(44);
assert.equal(pcm.length % 2, 0);
assert.deepEqual(wave.subarray(0, 44), wavHeader(pcm.length), "Replay requires a canonical WAV from the corpus preparation command");
const fd = openSync(output, "wx");
const controller = new AbortController();
const log = (type, row = {}) => appendFileSync(trace, `${JSON.stringify({ type, t: clock(), ...row })}\n`);
const clock = () => Number(process.hrtime.bigint()) / 1e6;
let pos = 0;
let maxPaceDelayMs = 0;
writeAll(wavHeader(0), 0);
const start = clock();
log("capture-start", { t: start });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
	for await (const unused of ticks(20, undefined, { signal: controller.signal })) {
		void unused;
		const target = Math.min(pcm.length, Math.floor((clock() - start) / 20) * RATE / 25);
		if (target <= pos) continue;
		writeAll(pcm.subarray(pos, target), pos + 44);
		if (pos === 0) log("capture-first", { samples: target / 2 });
		pos = target;
		maxPaceDelayMs = Math.max(maxPaceDelayMs, clock() - start - pos / 32);
		if (pos === pcm.length) log("capture-end", { samples: pos / 2, maxPaceDelayMs });
		// Stay alive (without adding any PCM) until Micme stops this recorder.
	}
} catch (error) {
	if (!controller.signal.aborted) throw error;
} finally {
	writeAll(wavHeader(pos), 0);
	closeSync(fd);
	log("capture-close", { samples: pos / 2 });
}

function stop() {
	controller.abort();
}

function writeAll(buf, offset) {
	assert.equal(writeSync(fd, buf, 0, buf.length, offset), buf.length);
}
