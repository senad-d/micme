import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setTimeout as delay } from "node:timers/promises";
import { envFlag, getTranscribeTimeoutMs } from "./config.ts";
import { deferred, formatExit, formatProcessOutput, normalizeTranscript, runProcess } from "./processes.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { pasteOrSubmitTranscript } from "./transcript-delivery.ts";
import type { CommandSpec, LivePlan, OwnedProcess } from "./types.ts";

const RATE = 16_000;
const LINE_BYTES = 64 * 1024;
const MAX_UPDATE_EVENTS = 64;
const POLL_MS = 30;

export type LiveText = { type: "partial" | "final"; from: number; to: number; text: string };
type Ready = { loadMs: number; asrLoads: number; vadLoads: number };
type Done = { through: number; asrCalls: number; asrMs: number; vadFrames: number };
type Phase = "ready" | "idle" | "feed" | "finish" | "done";

type WorkerTransport = Pick<OwnedProcess, "exitObserved" | "exitPromise"> & { process: Pick<OwnedProcess["process"], "stdin" | "stdout"> };

export function buildLiveWorkerCommand(plan: LivePlan): CommandSpec {
	const args = ["--model", plan.modelPath, "--vad-model", plan.vadModelPath, "--language", plan.language];
	if (plan.translate) args.push("--translate");
	// Busy OpenMP waits can stall each decoder token when a terminal, capture,
	// or another process also needs CPU. Scope the default to the live child.
	const env = process.env.OMP_WAIT_POLICY ? undefined : { ...process.env, OMP_WAIT_POLICY: "PASSIVE" };
	return { command: plan.binary, args, display: "micme-live", ...(env && { spawnOptions: { env } }) };
}

export async function probeLiveWorker(binary: string) {
	const probe = await runProcess(binary, ["--protocol-version"], Math.min(3_000, getTranscribeTimeoutMs()));
	if (probe.code !== 0 || probe.timedOut || probe.stdoutTruncated || probe.stdout !== "1\n") {
		throw new Error("micme-live did not report Worker v1. Rebuild it using native/live/README.md or correct MICME_LIVE_BIN.");
	}
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDuration(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function protocolError(reason: string): Error {
	return new Error(`Micme live worker protocol: ${reason}.`);
}

export class LiveWorker {
	readonly signal: AbortSignal;
	readonly ready: Promise<Ready>;
	readonly timeoutMs: number;
	through = 0;
	private readonly failed = new AbortController();
	private readonly child: WorkerTransport;
	private readonly onText: (update: LiveText) => void;
	private readonly bytes = Buffer.alloc(LINE_BYTES - 1);
	private readonly utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	private readonly loaded = deferred<Ready>();
	private phase: Phase = "ready";
	private buffered = 0;
	private inputThrough = 0;
	private finalThrough = 0;
	private draft: LiveText | undefined;
	private updates: LiveText[] = [];
	private previews = false;
	private ack: ReturnType<typeof deferred<void>> | undefined;
	private readonly done = deferred<Done>();

	constructor(child: WorkerTransport, signal: AbortSignal, onText: (update: LiveText) => void, timeoutMs = getTranscribeTimeoutMs()) {
		this.child = child;
		this.signal = AbortSignal.any([signal, this.failed.signal]);
		this.onText = onText;
		this.timeoutMs = timeoutMs;
		this.ready = this.wait(this.loaded.promise, "waiting for ready (model loading)");
		const { stdin, stdout } = child.process;
		if (!stdin || !stdout) this.fail(protocolError("worker pipes are unavailable"));
		stdin?.on("error", () => this.fail(protocolError("could not write PCM to stdin")));
		stdout?.on("data", this.read.bind(this));
		stdout?.on("error", () => this.fail(protocolError("could not read worker stdout")));
		stdout?.on("end", () => {
			if (this.buffered || this.phase !== "done") this.fail(protocolError("stdout closed before a complete done event"));
		});
		void child.exitObserved.then((exit) => {
			if ((this.phase !== "finish" && this.phase !== "done") || exit.code !== 0 || exit.signal || exit.error) {
				const result = sanitizeTerminalText(formatExit(exit)).slice(0, 256) || "unknown exit";
				this.fail(new Error(`Micme live worker exited unexpectedly (${result}). Check micme-live and its models.`));
			}
		});
	}

	get failure(): unknown {
		return this.failed.signal.reason as unknown;
	}

	fail(error: unknown) {
		if (!this.signal.aborted) this.failed.abort(error);
	}

	async send(pcm: Buffer, preview: boolean) {
		this.signal.throwIfAborted();
		if (this.phase !== "idle") throw protocolError("another worker request is already in flight");
		if (!pcm.length || pcm.length > RATE * 2 || pcm.length % 2 !== 0) throw protocolError("invalid PCM buffer size");
		const samples = pcm.length / 2;
		const frame = Buffer.allocUnsafe(5 + pcm.length);
		frame[0] = preview ? 1 : 2;
		frame.writeUInt32LE(samples, 1);
		pcm.copy(frame, 5);
		this.previews = preview;
		this.phase = "feed";
		this.inputThrough = this.through + samples;
		this.ack = deferred<void>();
		const result = this.wait(this.ack.promise, "waiting for a PCM acknowledgment");
		this.write(frame);
		await result;
		this.publishUpdates();
	}

	async finish() {
		this.signal.throwIfAborted();
		if (this.phase !== "idle") throw protocolError("another worker request is already in flight");
		this.phase = "finish";
		this.previews = false;
		const result = this.wait(Promise.all([this.done.promise, this.child.exitPromise]), "waiting for finish and worker exit");
		this.write(Buffer.of(3), true);
		const [done, exit] = await result;
		this.signal.throwIfAborted();
		if (exit.code !== 0 || exit.error || exit.signal || this.buffered) throw protocolError("finish did not end with a clean worker exit");
		this.publishUpdates();
		return done;
	}

	private async wait<T>(value: Promise<T>, label: string) {
		this.signal.throwIfAborted();
		const interrupt = deferred<never>();
		const abort = () => interrupt.reject(this.signal.reason as unknown);
		const timer = setTimeout(() => this.fail(new Error(`Micme live worker timed out ${label}.`)), this.timeoutMs);
		this.signal.addEventListener("abort", abort, { once: true });
		try {
			return await Promise.race([value, interrupt.promise]);
		} finally {
			clearTimeout(timer);
			this.signal.removeEventListener("abort", abort);
		}
	}

	private write(frame: Buffer, end = false) {
		const stdin = this.child.process.stdin;
		try {
			if (!stdin?.writable) throw protocolError("PCM input is closed");
			if (end) stdin.end(frame);
			else stdin.write(frame);
		} catch (error) {
			this.fail(error);
		}
	}

	private read(chunk: Buffer) {
		try {
			for (let start = 0; start < chunk.length && !this.signal.aborted;) {
				const lf = chunk.indexOf(0x0a, start);
				const end = lf === -1 ? chunk.length : lf;
				if (this.buffered + end - start > this.bytes.length) throw protocolError("event exceeds the 64 KiB limit");
				chunk.copy(this.bytes, this.buffered, start, end);
				this.buffered += end - start;
				if (lf === -1) return;
				const line = this.bytes.subarray(0, this.buffered);
				this.buffered = 0;
				this.consume(parseEvent(this.utf8, line));
				start = end + 1;
			}
		} catch (error) {
			this.fail(error);
		}
	}

	private consume(event: Record<string, unknown>) {
		switch (event.type) {
			case "error": {
				if (typeof event.message !== "string") throw protocolError("invalid error event");
				const message = sanitizeTerminalText(event.message).slice(0, 500);
				throw new Error(`Micme live worker failed: ${message || "decoder error"}`);
			}
			case "ready": {
				const { version, rate, loadMs, asrLoads, vadLoads } = event;
				if (this.phase !== "ready" || version !== 1 || rate !== RATE || !isDuration(loadMs) || asrLoads !== 1 || vadLoads !== 1) {
					throw protocolError("invalid ready event (expected Worker v1, 16 kHz and one load per model)");
				}
				this.phase = "idle";
				this.loaded.resolve({ loadMs, asrLoads, vadLoads });
				return;
			}
			case "ack": {
				if (this.phase !== "feed" || !this.ack || event.through !== this.inputThrough) throw protocolError("unexpected PCM acknowledgment or sample count");
				this.through = this.inputThrough;
				this.phase = "idle";
				this.ack.resolve();
				this.ack = undefined;
				return;
			}
			case "done": {
				const { through, asrCalls, asrMs, vadFrames } = event;
				if (this.phase !== "finish" || !isCount(through) || through !== this.through || !isCount(asrCalls) || !isCount(vadFrames) || !isDuration(asrMs)) {
					throw protocolError("unexpected done event or sample count");
				}
				this.phase = "done";
				this.done.resolve({ through, asrCalls, asrMs, vadFrames });
				return;
			}
			case "final":
			case "partial":
				this.stageText(event.type, event);
				return;
			default:
				throw protocolError("unknown event type");
		}
	}

	private stageText(type: LiveText["type"], { from, to, text }: Record<string, unknown>) {
		if ((this.phase !== "feed" && this.phase !== "finish") || (type === "partial" && !this.previews) ||
			!isCount(from) || !isCount(to) || from < this.finalThrough || to <= from || to > this.inputThrough ||
			typeof text !== "string" || /[\uD800-\uDFFF]/u.test(text)) {
			throw protocolError("invalid text event or sample range");
		}
		if (this.updates.length >= MAX_UPDATE_EVENTS) throw protocolError("too many text events without a response");
		const update = { type, from, to, text: normalizeTranscript(text) };
		if (type === "final") {
			this.finalThrough = to;
			this.draft = undefined;
		} else {
			if (this.draft && (from < this.draft.from || to <= this.draft.to)) throw protocolError("stale partial event");
			this.draft = update;
		}
		this.updates.push(update);
	}

	private publishUpdates() {
		this.signal.throwIfAborted();
		const updates = this.updates;
		this.updates = [];
		for (const update of updates) this.onText(update);
	}

}

function parseEvent(decoder: TextDecoder, line: Buffer): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(line));
	} catch {
		throw protocolError("invalid UTF-8 or JSON event");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw protocolError("expected a JSON event object");
	return parsed as Record<string, unknown>;
}

export function livePoll(signal: AbortSignal) {
	return delay(POLL_MS, undefined, { signal });
}

export function caughtUpForLivePreview(availableThrough: number, acknowledgedThrough: number) {
	return availableThrough - acknowledgedThrough <= RATE;
}

export function liveWorkerDiagnostics(process: OwnedProcess) {
	return formatProcessOutput(process.stderr().slice(-2_000));
}

export class LiveTranscript {
	private readonly ctx: ExtensionContext;
	private readonly baseText: string;
	private renderedEditorText: string;
	private editorTextInserted = false;
	private readonly confirmed: string[] = [];

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
		this.baseText = ctx.mode === "rpc" ? "" : ctx.ui.getEditorText();
		this.renderedEditorText = this.baseText;
	}

	commit(text: string) {
		if (!text) return;
		const betweenSpans = this.confirmed.length > 0;
		this.confirmed.push(text);
		if (this.ctx.mode === "rpc") return;
		const observed = this.observeEditor();
		this.ctx.ui.setEditorText(appendTranscript(observed, text, betweenSpans));
		// Read back: Pi may normalize line endings or tabs.
		this.renderedEditorText = this.ctx.ui.getEditorText();
	}

	get text() {
		return this.confirmed.join(" ");
	}

	deliver(pi: ExtensionAPI, transcript: string, refined: boolean) {
		const ctx = this.ctx;
		const submit = envFlag("MICME_AUTO_SUBMIT");
		if (ctx.mode === "rpc") {
			ctx.ui.notify(submit
				? "Micme saved the transcript. Explicit /micme last will send it or queue it as a follow-up; turn off auto-submit first if you want to review it."
				: "Micme saved the transcript. Explicit /micme last will replace the RPC prompt; save the current prompt first.", "info");
			return;
		}
		if (!refined && !submit) return;
		this.observeEditor();
		if (this.editorTextInserted) {
			ctx.ui.notify("Micme did not replace or send the transcript because the editor was edited during dictation. Use /micme last to retrieve it.", "warning");
			return;
		}
		if (submit) {
			ctx.ui.setEditorText(this.baseText);
			pasteOrSubmitTranscript(ctx, pi, transcript);
		} else {
			ctx.ui.setEditorText(appendTranscript(this.baseText, transcript));
		}
	}

	private observeEditor() {
		const observed = this.ctx.ui.getEditorText();
		// Clearing or trimming Micme's suffix alone does not latch an insertion.
		if (!this.renderedEditorText.startsWith(observed)) this.editorTextInserted = true;
		return observed;
	}
}

function appendTranscript(base: string, text: string, betweenSpans = false) {
	const separator = base && !/\s$/.test(base) && (betweenSpans || !".,!?;:)}]".includes(text.charAt(0))) ? " " : "";
	return `${base}${separator}${text} `;
}
