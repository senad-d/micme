import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";
import { findExecutable } from "../processes.ts";
import { getCatalogVariant } from "./catalog.ts";
import type { Choice, DeviceIdentity, DeviceOption, Engine, SpeechLanguage, Traits, WordUpdate } from "./contracts.ts";

const BINARY = "micme-recognizer";
const MAX_SAMPLES = 120 * 16_000;
const MAX_RESPONSE = 256 * 1024;
const DEADLINE_MS = 60_000;
const CLOSE_MS = 2_000;
const SHA256 = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type NativeHelper = { recognizerFile: string; recognizerSha256: string };
export type EngineProvisioning = Partial<NativeHelper> & {
	engineModelFiles: readonly { variantId: string; blobPath: string; file: string; sha256: string }[];
	threads?: number;
	observe?: (event: NativeEvent) => void;
};
export type NativeEvent =
	| { kind: "feed"; from: number; through: number; catchUp: boolean }
	| { kind: "ack" | "done"; through: number }
	| { kind: "finish" }
	| { kind: "endpoint"; text: string };
type NativeCounters = { asrCalls: number; asrLoads: number; vadLoads: number; peakRssBytes: number | null };
export type NativeEvidence = NativeCounters & { inputSamples: number; inputPcmSha256: string; workerCleanExit: boolean };
export type NativeEngine = Engine & {
	pid: number | undefined;
	binarySha256: string;
	threads: number;
	maxInputSamples: number;
	feed: (from: number, pcm: Uint8Array, last: boolean, signal: AbortSignal, catchUp?: boolean) => Promise<WordUpdate[]>;
	evidence: () => NativeEvidence;
};

type Reply = Record<string, unknown>;
type Connection = ChildProcessByStdio<Writable, Readable, null>;

class NativePipe {
	readonly child: Connection;
	readonly exit: Promise<Awaited<ReturnType<typeof childExit>>>;
	counters?: NativeCounters;
	#pending?: { resolve: (value: Reply) => void; reject: (error: unknown) => void };
	#buffer: Buffer = Buffer.alloc(0);
	#failed = false;

	constructor(binary: FileHandle, model?: FileHandle) {
		// Execute the verified file through the inherited descriptor, even if its pathname changes.
		this.child = spawn("/proc/self/fd/4", [String(process.pid)], { stdio: ["pipe", "pipe", "ignore", model?.fd ?? "ignore", binary.fd], env: {} }) as Connection;
		this.exit = childExit(this.child);
		void this.exit.then(() => this.fail(new Error("The native recognizer exited.")));
		this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
		this.child.stdout.on("error", () => this.fail(new Error("The native recognizer read pipe failed.")));
		this.child.stdin.on("error", () => this.fail(new Error("The native recognizer write pipe failed.")));
	}

	private receive(chunk: Buffer) {
		if (this.#failed) return;
		const pending = this.#pending;
		if (!pending || this.#buffer.length + chunk.length > MAX_RESPONSE + 4) {
			this.fail(new Error("Unexpected native recognizer reply."));
			return;
		}
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		if (this.#buffer.length < 4) return;
		const bytes = this.#buffer.readUInt32BE(0);
		if (!bytes || bytes > MAX_RESPONSE || this.#buffer.length > bytes + 4) {
			this.fail(new Error("Invalid native recognizer frame length."));
			return;
		}
		if (this.#buffer.length < bytes + 4) return;
		try {
			const reply = object(JSON.parse(decoder.decode(this.#buffer.subarray(4))));
			if (reply.version !== 1) throw badReply();
			this.counters = parseCounters(reply, this.counters);
			if (reply.ok === false && typeof reply.error === "string" && /^[A-Za-z0-9 .-]{1,160}$/.test(reply.error)) {
				this.fail(new Error(reply.error));
				return;
			}
			if (reply.ok !== true) throw badReply();
			const data = object(reply.data);
			this.#pending = undefined;
			this.#buffer = Buffer.alloc(0);
			pending.resolve(data);
		} catch {
			this.fail(badReply());
		}
	}

	async request(op: string, fields: readonly Uint8Array[], signal: AbortSignal, timeout = DEADLINE_MS): Promise<Reply> {
		if (this.#failed || this.#pending) throw new Error("Native recognizer is unavailable or busy.");
		const abort = () => this.fail(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => this.fail(new Error("The native recognizer timed out.")), timeout);
		try {
			if (signal.aborted) { abort(); signal.throwIfAborted(); }
			const header = Buffer.alloc(5);
			header.writeUInt32BE(1 + fields.reduce((sum, field) => sum + field.byteLength, 0), 0);
			header[4] = op.charCodeAt(0);
			const reply = await new Promise<Reply>((resolve, reject) => {
				this.#pending = { resolve, reject };
				this.child.stdin.write(Buffer.concat([header, ...fields]));
			});
			signal.throwIfAborted();
			return reply;
		} catch (error) {
			this.fail(error);
			await this.exit;
			throw error;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
	}

	fail(error: unknown) {
		if (this.#failed) return;
		this.#failed = true;
		const pending = this.#pending;
		this.#pending = undefined;
		this.#buffer = Buffer.alloc(0);
		this.child.kill("SIGKILL");
		this.child.stdin.destroy();
		pending?.reject(error);
	}

	async close(): Promise<boolean> {
		if (this.#pending) this.fail(new Error("The native recognizer was closed."));
		let graceful = false;
		const signal = AbortSignal.timeout(CLOSE_MS);
		const timer = setTimeout(() => this.fail(new Error("Native recognizer shutdown timed out.")), CLOSE_MS);
		try {
			await this.request("Q", [], signal, CLOSE_MS);
			graceful = true;
		} catch {
			// Faults/cancel already killed the process; do not report a graceful exit.
		} finally {
			await this.exit;
			clearTimeout(timer);
		}
		return graceful && await this.exit === 0;
	}
}

function childExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve) => {
		child.once("error", () => resolve(null));
		child.once("close", resolve);
	});
}

function badReply() { return new Error("Invalid native recognizer reply."); }

function object(value: unknown): Reply {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw badReply();
	return value as Reply;
}

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw badReply();
	return value;
}

function parseCounters(reply: Reply, previous?: NativeCounters): NativeCounters {
	const result = { asrCalls: count(reply.asrCalls), asrLoads: count(reply.asrLoads), vadLoads: count(reply.vadLoads), peakRssBytes: reply.peakRssBytes === null ? null : count(reply.peakRssBytes) };
	if (previous && (result.asrCalls < previous.asrCalls || result.asrLoads < previous.asrLoads || result.vadLoads < previous.vadLoads)) throw badReply();
	return result;
}

function device(value: unknown): DeviceIdentity | null {
	if (value === null) return null;
	const { id, label } = object(value);
	if (id !== null && (typeof id !== "string" || !id || id.includes("\0"))) throw badReply();
	if (label !== null && (typeof label !== "string" || !label || label.includes("\0"))) throw badReply();
	if (id === null && label === null) throw badReply();
	return typeof id === "string" ? { id, label } : { id: null, label: label as string };
}

function backend(value: unknown): DeviceOption["backend"] {
	if (value !== "cpu" && value !== "metal" && value !== "vulkan") throw badReply();
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw badReply();
	return value;
}

function parseTraits(value: unknown): Traits {
	const traits = object(value);
	if (!Array.isArray(traits.languages) || traits.languages.some((lang) => typeof lang !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(lang))) throw badReply();
	const { vad, actualCompute } = traits;
	if (vad !== "native" && vad !== "silero" && vad !== "off") throw badReply();
	return {
		stream: boolean(traits.stream), batch: boolean(traits.batch), longForm: boolean(traits.longForm),
		nativeLid: boolean(traits.nativeLid), bias: boolean(traits.bias), translateEn: boolean(traits.translateEn),
		languages: [...traits.languages], vad, actualCompute: actualCompute === "unknown" ? "unknown" : backend(actualCompute), boundDevice: device(traits.boundDevice),
	};
}

function parseSamples(reply: Reply, kind: string, through: number) {
	if (reply.kind !== kind || reply.through !== through || typeof reply.text !== "string" || typeof reply.changed !== "boolean") throw badReply();
	return { text: reply.text, changed: reply.changed };
}

function numberField(value: number) {
	const field = Buffer.alloc(4);
	field.writeUInt32BE(value, 0);
	return field;
}

function stringField(value: string, maxBytes: number) {
	if (value.includes("\0") || Buffer.byteLength(value) > maxBytes) throw new Error("Invalid native recognizer option.");
	const text = Buffer.from(value);
	return Buffer.concat([numberField(text.length), text]);
}

function supportedLanguage(language: SpeechLanguage, traits: Traits): boolean {
	return language === "auto" ? traits.nativeLid || traits.languages.length === 1 : traits.languages.includes(language);
}

function sameFile(before: BigIntStats, after: BigIntStats) {
	return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function pinnedFile(path: string, signal: AbortSignal, sha256?: string, bytes?: number) {
	if (!isAbsolute(path) || (sha256 !== undefined && !SHA256.test(sha256))) throw new Error("Native recognition requires an absolute local file and a valid SHA-256 pin when supplied.");
	signal.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(() => { throw new Error("A native recognizer input is missing or not a regular file."); });
	try {
		const stat = await file.stat({ bigint: true });
		if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER) || (bytes !== undefined && stat.size !== BigInt(bytes))) throw new Error("A native recognizer input does not match its expected file size.");
		const hash = createHash("sha256");
		for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: Number(stat.size) - 1, signal })) hash.update(chunk);
		const digest = hash.digest("hex");
		if ((sha256 !== undefined && digest !== sha256) || !sameFile(stat, await file.stat({ bigint: true }))) throw new Error("A native recognizer input does not match its pinned bytes.");
		return { file, stat, digest };
	} catch (error) {
		await file.close();
		throw error;
	}
}

async function helper(provision: Partial<NativeHelper>, signal: AbortSignal) {
	signal.throwIfAborted();
	if (process.platform !== "linux") return null;
	if ((Object.hasOwn(provision, "recognizerFile") || Object.hasOwn(provision, "recognizerSha256")) && (!provision.recognizerFile || !provision.recognizerSha256)) throw new Error("Specify both the native recognizer file and its SHA-256.");
	const path = provision.recognizerFile ?? findExecutable([BINARY]);
	return path ? pinnedFile(path, signal, provision.recognizerSha256) : null;
}

/** Optional runtime enumeration, not a qualified model/device offer or evidence of binding. */
export async function listCompute(provision: Partial<NativeHelper> = {}, signal = new AbortController().signal): Promise<DeviceOption[]> {
	const binary = await helper(provision, signal);
	if (!binary) return [];
	let pipe: NativePipe | undefined;
	try {
		pipe = new NativePipe(binary.file);
		const { devices } = await pipe.request("V", [], signal);
		if (!sameFile(binary.stat, await binary.file.stat({ bigint: true })) || !Array.isArray(devices)) throw badReply();
		return devices.map((entry: unknown) => {
			const row = object(entry);
			return { backend: backend(row.backend), device: device(row.device) };
		});
	} finally {
		await pipe?.close();
		await binary.file.close();
	}
}

/** Open exact local bytes, including for an opt-in trial. Product selection must apply the catalog's rig/task gate first. */
export async function loadEngine(choice: Choice, signal: AbortSignal, provision?: EngineProvisioning): Promise<NativeEngine> {
	signal.throwIfAborted();
	const variant = getCatalogVariant(choice.variantId);
	if (!variant || variant.rights !== "cleared" || !variant.blobs.length) throw new Error("Native recognition requires a rights-cleared exact catalog variant.");
	if (variant.blobs.length !== 1) throw new Error("This native recognizer supports only single-blob model variants.");
	const blob = variant.blobs[0]!;
	const selected = provision?.engineModelFiles.filter((row) => row.variantId === variant.id) ?? [];
	if (selected.length !== 1 || selected[0]!.blobPath !== blob.path || selected[0]!.sha256 !== blob.sha256) throw new Error("Provision the exact native model from the ledger for offline recognition.");
	const threads = provision?.threads ?? 4;
	if (!Number.isSafeInteger(threads) || threads < 1 || threads > 32) throw new Error("Invalid native recognizer thread count.");
	const opts = [stringField(choice.compute, 16), stringField(choice.requestedDeviceId ?? "", 256), numberField(threads)];
	const binary = await helper(provision ?? {}, signal);
	if (!binary) throw new Error("The optional Linux native recognizer is not installed.");
	let model: Awaited<ReturnType<typeof pinnedFile>> | undefined;
	let pipe: NativePipe | undefined;
	try {
		model = await pinnedFile(selected[0]!.file, signal, blob.sha256, blob.bytes);
		signal.throwIfAborted();
		pipe = new NativePipe(binary.file, model.file);
		const loaded = await pipe.request("L", opts, signal);
		if (!sameFile(binary.stat, await binary.file.stat({ bigint: true })) || !sameFile(model.stat, await model.file.stat({ bigint: true }))) throw new Error("The native recognizer input changed during model load.");
		const traits = parseTraits(loaded.traits);
		const maxInputSamples = count(loaded.maxInputSamples);
		if (!maxInputSamples || maxInputSamples > MAX_SAMPLES || loaded.threads !== threads || pipe.counters?.asrLoads !== 1 || !traits.batch || traits.bias || traits.translateEn || traits.vad !== "off") throw badReply();
		if ((choice.compute !== "auto" && traits.actualCompute !== choice.compute) || (choice.requestedDeviceId !== null && traits.boundDevice?.id !== choice.requestedDeviceId)) throw new Error("The loaded native device does not match the selected compute option.");
		if (!supportedLanguage(choice.language, traits)) throw new Error("The loaded native model does not support the selected language.");
		if (choice.task !== "transcribe") throw new Error("The loaded native model does not support translation to English.");
		const detector = choice.detector === "model" ? "native" : choice.detector;
		if (detector !== traits.vad) throw new Error("The loaded native model does not support the selected speech detector.");
		signal.throwIfAborted();
		return new BoundEngine(pipe, traits, threads, maxInputSamples, binary.digest, provision?.observe);
	} catch (error) {
		await pipe?.close();
		throw error;
	} finally {
		await model?.file.close();
		await binary.file.close();
	}
}

class BoundEngine implements NativeEngine {
	#active = false;
	#busy = false;
	#through = 0;
	#inputHash: Hash = createHash("sha256");
	#closed?: Promise<void>;
	#clean = false;
	readonly #pipe: NativePipe;
	readonly #observe?: EngineProvisioning["observe"];
	readonly traits: Traits;
	readonly threads: number;
	readonly maxInputSamples: number;
	readonly binarySha256: string;

	constructor(pipe: NativePipe, traits: Traits, threads: number, maxInputSamples: number, binarySha256: string, observe?: EngineProvisioning["observe"]) {
		this.#pipe = pipe;
		this.#observe = observe;
		this.threads = threads;
		this.maxInputSamples = maxInputSamples;
		this.binarySha256 = binarySha256;
		this.traits = traits;
		Object.freeze(traits.languages);
		Object.freeze(traits.boundDevice);
		Object.freeze(traits);
	}

	get pid() { return this.#pipe.child.pid; }

	evidence(): NativeEvidence {
		const counters = this.#pipe.counters;
		if (!counters) throw badReply();
		return { ...counters, inputSamples: this.#through, inputPcmSha256: this.#inputHash.copy().digest("hex"), workerCleanExit: this.#clean };
	}

	private async run<T>(signal: AbortSignal, work: () => Promise<T>) {
		if (this.#busy || this.#closed) throw new Error("Native recognizer is unavailable or busy.");
		this.#busy = true;
		try {
			signal.throwIfAborted();
			const result = await work();
			this.checkCurrent(signal);
			return result;
		} catch (error) {
			this.#pipe.fail(error);
			await this.close();
			throw error;
		} finally {
			this.#busy = false;
		}
	}

	private checkCurrent(signal: AbortSignal) {
		signal.throwIfAborted();
		if (this.#closed) throw new Error("The native recognizer was closed.");
	}

	private clearInput() {
		this.#through = 0;
		this.#inputHash = createHash("sha256");
	}

	async begin(lang: SpeechLanguage, words: readonly string[], signal: AbortSignal) {
		if (!this.traits.stream || this.#active || words.length || !supportedLanguage(lang, this.traits)) throw new Error("Unsupported native recognizer stream options.");
		await this.run(signal, async () => {
			await this.#pipe.request("B", [stringField(lang, 64)], signal);
			this.clearInput();
			this.#active = true;
		});
	}

	async feed(from: number, pcm: Uint8Array, last: boolean, signal: AbortSignal, catchUp = false) {
		const through = from + pcm.byteLength / 2;
		if (!this.#active || from !== this.#through || pcm.byteLength % 2) throw new Error("Invalid or non-contiguous native stream PCM.");
		if (through > this.maxInputSamples) throw new Error("PCM exceeds the loaded native model's bounded audio limit.");
		return this.run(signal, async () => {
			const updates: WordUpdate[] = [];
			if (pcm.byteLength) {
				const block = Buffer.from(pcm);
				this.#observe?.({ kind: "feed", from, through, catchUp });
				this.checkCurrent(signal);
				const result = parseSamples(await this.#pipe.request("F", [numberField(from), block], signal), "ack", through);
				this.checkCurrent(signal);
				this.#through = through;
				this.#inputHash.update(block);
				this.#observe?.({ kind: "ack", through });
				if (result.changed && !last) updates.push({ kind: "draft", from: 0, to: through, text: result.text });
			}
			if (last) {
				this.checkCurrent(signal);
				this.#observe?.({ kind: "finish" });
				this.checkCurrent(signal);
				const result = parseSamples(await this.#pipe.request("D", [numberField(through)], signal), "done", through);
				this.checkCurrent(signal);
				this.#active = false;
				this.#observe?.({ kind: "done", through });
				this.checkCurrent(signal);
				if (result.text) this.#observe?.({ kind: "endpoint", text: result.text });
				updates.push({ kind: "commit", from: 0, to: through, text: result.text });
			}
			return updates;
		});
	}

	async batch(pcm: Uint8Array, lang: SpeechLanguage, signal: AbortSignal) {
		const through = pcm.byteLength / 2;
		if (!this.traits.batch || this.#active || pcm.byteLength % 2 || !supportedLanguage(lang, this.traits)) throw new Error("Unsupported native batch input or language.");
		if (through > this.maxInputSamples) throw new Error("PCM exceeds the loaded native model's bounded audio limit.");
		return this.run(signal, async () => {
			const block = Buffer.from(pcm);
			const result = parseSamples(await this.#pipe.request("T", [stringField(lang, 64), block], signal), "batch", through);
			this.checkCurrent(signal);
			this.clearInput();
			this.#through = through;
			this.#inputHash.update(block);
			return result.text;
		});
	}

	async reset(signal: AbortSignal) {
		await this.run(signal, async () => {
			await this.#pipe.request("R", [], signal);
			this.#active = false;
			this.clearInput();
		});
	}

	close() {
		this.#closed ??= this.#pipe.close().then((clean) => { this.#clean = clean; });
		return this.#closed;
	}
}
