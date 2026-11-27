import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { hasNonzeroPcm } from "../audio-level.ts";
import { installedWhisperModels } from "../backends.ts";
import { env, expandConfigPath, getTranscribeBackend, getTransferOptions } from "../config.ts";
import { LIVE_CAPTURE_RATE as RATE } from "../constants.ts";
import { assertLoadedBinding, loadedRecognitionRoute } from "../live-plan.ts";
import { isEnglishOnlyWhisperModelName, isTranslationUnsupportedWhisperModelName } from "../models.ts";
import { findExecutable, normalizeTranscript } from "../processes.ts";
import { transcribeInstalledWhisper } from "../transcription.ts";
import { getManagedCatalogVariant, referenceRows, whisperVariants } from "./catalog.ts";
import type { Choice, DeviceIdentity, EnsureManaged, FileJob, Final, ListCompute, ListInstalled, OpenRecognizer, RecognizedFile, RecognizeFile, Recognizer, Signal, SpeechLanguage, Traits, TransferOptions, Unload, Variant, VerifiedAudio, WordUpdate } from "./contracts.ts";
import { listCompute as enumerateNative, loadEngine, type EngineProvisioning, type NativeEngine, type NativeEvent } from "./engine.ts";
import { getEngineEvidence } from "./engine-evidence.ts";
import { RecognitionQueue, recognitionQueue } from "./jobs.ts";
import { finishLocal, resolveLanguage } from "./language.ts";
import { invalidRecognitionAudio, joinChunks, PauseChunks, withVerifiedPcm, type VerifiedPcm } from "./recognition-audio.ts";

type Idle = TransferOptions["MICME_MODEL_IDLE"];
type Route = ReturnType<typeof loadedRecognitionRoute>;
type Evidence = ReturnType<NativeEngine["evidence"]>;
type Observation = NativeEvent
	| { kind: "loaded"; fresh: boolean; traits: Traits; pid: number | undefined; sha256: string; threads: number; evidence: Evidence }
	| { kind: "batch"; from: number; to: number; text: string; evidence: Evidence }
	| { kind: "snapshot"; samples: number; pcmSha256: string }
	| { kind: "final"; final: Final; evidence: Evidence | null; inputSamples: number; inputPcmSha256: string }
	| { kind: "released"; resident: boolean; pid: number | undefined; evidence: Evidence }
	| { kind: "failed" };

type ServiceOptions = {
	load?: (choice: Choice, signal: Signal, observe: (event: NativeEvent) => void) => Promise<NativeEngine>;
	queue?: RecognitionQueue;
	settings?: () => Pick<TransferOptions, "MICME_MODEL_IDLE" | "MICME_PREFERRED_LANGUAGES" | "MICME_WORDS">;
	observe?: (event: Observation) => void;
};
type FileOptions = { whole?: boolean; onCpuRecovery?: () => void };
const EMPTY = Buffer.alloc(0);
const FIVE_MINUTES = 300_000;
const observers = new Set<(event: Observation) => void>();
const qualifiedLanguages = new WeakMap<NativeEngine, readonly string[]>();

/** Explicit, in-process observation for public qualification; never log audio/text by default. */
export function observeRecognition(observe: (event: Observation) => void) {
	observers.add(observe);
	return () => { observers.delete(observe); };
}

function publish(observe: NonNullable<ServiceOptions["observe"]>, event: Observation) {
	try { observe(event); } catch { /* An observer must not control capture or output. */ }
}

function notifyObservers(event: Observation) {
	for (const observer of observers) publish(observer, event);
}

function sameDevice(left: DeviceIdentity | null, right: DeviceIdentity | null) {
	return left?.id === right?.id && left?.label === right?.label;
}

async function localDigest(path: string, signal: Signal, bytes?: number) {
	signal.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || (bytes !== undefined && stat.size !== bytes)) throw new Error("The local artifact is not an exact regular file.");
		const hash = createHash("sha256");
		for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk);
		return hash.digest("hex");
	} finally { await file.close(); }
}

async function installedNativeHost(signal: Signal) {
	if (process.platform !== "linux" || process.arch !== "x64") return null;
	const recognizerFile = findExecutable(["micme-recognizer"]);
	if (!recognizerFile || !isAbsolute(recognizerFile)) return null;
	const release = await readFile("/etc/os-release", "utf8").catch(() => "");
	const id = /^ID="?([\w-]+)"?$/m.exec(release)?.[1];
	const version = /^VERSION_ID="?([\d.]+)"?$/m.exec(release)?.[1];
	const model = cpus()[0]?.model;
	const processor = model && /\bi[3579]-\d+\b/u.exec(model)?.[0];
	if (!id || !version || !processor) return null;
	const recognizerSha256 = await localDigest(recognizerFile, signal);
	return { recognizerFile, recognizerSha256, key: `linux-x86_64/${id}-${version}/${processor}/4t/headless/sha256:${recognizerSha256}` };
}

type NativeHost = NonNullable<Awaited<ReturnType<typeof installedNativeHost>>>;

function qualifiedVariant(choice: Choice, host: NativeHost) {
	const observation = getEngineEvidence(choice.variantId);
	const traits = observation?.traits;
	if (!traits || traits.actualCompute === "unknown") return null;
	if ((choice.compute !== "auto" && choice.compute !== traits.actualCompute) ||
		(choice.requestedDeviceId !== null && choice.requestedDeviceId !== traits.boundDevice?.id)) return null;
	const scope = { rig: host.key, actualCompute: traits.actualCompute, device: traits.boundDevice };
	const languages = choice.language === "auto" ? traits.languages : [choice.language];
	for (const language of languages) {
		const variant = getManagedCatalogVariant(choice.variantId, scope, choice.task, language);
		if (variant) return variant;
	}
	return null;
}

function ignoreProgress() { /* Installed recognition cannot download. */ }

async function localModel(variant: Variant, signal: Signal) {
	const blob = variant.blobs[0];
	if (variant.blobs.length !== 1 || !blob) throw new Error("The native runtime requires one exact installed model blob.");
	const configured = env("MICME_MODEL_DIR");
	if (configured && basename(blob.path) === blob.path) {
		const dir = expandConfigPath(configured);
		if (isAbsolute(dir)) {
			const file = join(dir, blob.path);
			try {
				if (await localDigest(file, signal, blob.bytes) !== blob.sha256) throw new Error("The configured native model failed its exact digest check.");
				return file;
			} catch (error) {
				signal.throwIfAborted();
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
	}
	const managed = await import("./managed.ts") as { ensureManaged?: EnsureManaged };
	if (managed.ensureManaged) return managed.ensureManaged(variant, false, ignoreProgress, signal);
	throw new Error("Install the exact model before starting local recognition.");
}

async function loadInstalledNative(choice: Choice, signal: Signal, observe: NonNullable<EngineProvisioning["observe"]>) {
	const host = await installedNativeHost(signal);
	const variant = host && qualifiedVariant(choice, host);
	if (!host || !variant?.traits) throw new Error("The selected native model, task or compute option is not qualified for this installation.");
	const allowed = variant.languages;
	const language = choice.language === "auto" && allowed.length === 1 ? allowed[0]! : choice.language;
	const selected = { ...choice, language };
	const file = await localModel(variant, signal);
	const blob = variant.blobs[0]!;
	const engine = await loadEngine(selected, signal, { recognizerFile: host.recognizerFile, recognizerSha256: host.recognizerSha256,
		engineModelFiles: [{ variantId: choice.variantId, blobPath: blob.path, file, sha256: blob.sha256 }], observe });
	if (engine.traits.actualCompute !== variant.traits.actualCompute || !sameDevice(engine.traits.boundDevice, variant.traits.boundDevice)) {
		await engine.close();
		throw new Error("The loaded recognizer does not match the qualified device binding.");
	}
	qualifiedLanguages.set(engine, allowed);
	return engine;
}

function defaultChoice(variantId: string): Choice {
	return { variantId, compute: "auto", requestedDeviceId: null, language: "auto", task: "transcribe", detector: "off", chunking: true };
}

export const listInstalled: ListInstalled = async () => {
	const choices = legacyModels().map(({ id }) => defaultChoice(id));
	const signal = new AbortController().signal;
	const host = await installedNativeHost(signal).catch(() => null);
	if (!host) return choices;
	for (const row of referenceRows()) {
		for (const { id } of row.variants) {
			const choice = defaultChoice(id);
			const variant = qualifiedVariant(choice, host);
			if (!variant) continue;
			try { await localModel(variant, signal); choices.push({ ...choice, language: variant.languages[0]! }); }
			catch { /* Discovery alone is not a verified installation. */ }
		}
	}
	return choices;
};

export const listCompute: ListCompute = async () => {
	const devices: Awaited<ReturnType<ListCompute>> = [];
	const signal = new AbortController().signal;
	const host = await installedNativeHost(signal).catch(() => null);
	if (host) {
		const measured = referenceRows().flatMap(({ variants }) => variants.flatMap(({ id }) => qualifiedVariant(defaultChoice(id), host)?.traits ?? []));
		devices.push(...(await enumerateNative(host, signal)).filter(({ backend, device }) => measured.some((traits) => traits.actualCompute === backend && sameDevice(traits.boundDevice, device))));
	}
	if (legacyModels().length && !devices.some(({ backend, device }) => backend === "cpu" && device === null)) devices.push({ backend: "cpu", device: null });
	return devices;
};

function legacyModels() {
	try { return installedWhisperModels(); } catch { return []; }
}

function takeLanguage(choice: Choice, engine: NativeEngine, preferences: readonly string[]): SpeechLanguage {
	const qualified = qualifiedLanguages.get(engine);
	const traits = qualified ? { ...engine.traits, languages: engine.traits.languages.filter((language) => qualified.includes(language)) } : engine.traits;
	const lang = resolveLanguage(choice, traits, preferences, null);
	if (lang === "auto" && qualified && traits.languages.length === 1) return traits.languages[0]!;
	if (lang !== "auto" && traits.languages.includes(lang)) return lang;
	if (lang === "auto" && traits.nativeLid) return lang;
	if (lang === "auto" && traits.languages.length === 1) return traits.languages[0]!;
	throw new Error("The loaded recognition model does not support the selected language.");
}

function finalText(raw: string, language: SpeechLanguage, source: Final["source"], nativeBias: boolean) {
	const final = finishLocal(normalizeTranscript(raw), language === "auto" ? null : language, source);
	if (!nativeBias) return final;
	return { ...final, rules: [...final.rules.filter(({ rule }) => rule !== "bias"), { rule: "bias", result: "applied", reason: "applied" }] } satisfies Final;
}

function engineKey(choice: Choice) { return JSON.stringify([choice.variantId, choice.compute, choice.requestedDeviceId, choice.detector, choice.task, choice.language]); }

type Slot = { engine: NativeEngine; key: string; timer?: NodeJS.Timeout };
type Lease = { engine: NativeEngine; release: (good: boolean, idle: Idle, signal: Signal) => Promise<void> };

class ModelPool {
	private idle?: Slot;
	private unloadGeneration = 0;
	private readonly load: NonNullable<ServiceOptions["load"]>;
	private readonly observe: (event: Observation) => void;

	constructor(load: NonNullable<ServiceOptions["load"]>, observe: (event: Observation) => void) {
		this.load = load;
		this.observe = observe;
	}

	async acquire(choice: Choice, signal: Signal, fresh = false): Promise<Lease> {
		signal.throwIfAborted();
		const generation = this.unloadGeneration;
		const prior = this.takeIdle();
		const key = engineKey(choice);
		let engine = prior?.engine;
		if (prior && (fresh || prior.key !== key)) {
			await this.close(prior.engine);
			engine = undefined;
		}
		if (engine) {
			try { await engine.reset(signal); } catch { await this.close(engine); engine = undefined; }
		}
		signal.throwIfAborted();
		const loadedFresh = !engine;
		engine ??= await this.load(choice, signal, this.observe);
		this.observe({ kind: "loaded", fresh: loadedFresh, traits: engine.traits, pid: engine.pid, sha256: engine.binarySha256, threads: engine.threads, evidence: engine.evidence() });
		return { engine, release: this.release.bind(this, engine, key, generation) };
	}

	private async release(engine: NativeEngine, key: string, generation: number, good: boolean, idle: Idle, signal: Signal) {
		if (good && idle !== "immediate" && !signal.aborted && generation === this.unloadGeneration) {
			try {
				await engine.reset(signal);
				if (!signal.aborted && generation === this.unloadGeneration) {
					const slot: Slot = { engine, key };
					this.idle = slot;
					if (idle === "5min") slot.timer = setTimeout(() => { void this.unload().catch(() => {}); }, FIVE_MINUTES).unref();
					this.observe({ kind: "released", resident: true, pid: engine.pid, evidence: engine.evidence() });
					return;
				}
			} catch { /* A worker that cannot reset must never serve the next take. */ }
		}
		await this.close(engine);
	}

	private async close(engine: NativeEngine) {
		await engine.close();
		this.observe({ kind: "released", resident: false, pid: engine.pid, evidence: engine.evidence() });
	}

	private takeIdle() {
		const slot = this.idle;
		this.idle = undefined;
		clearTimeout(slot?.timer);
		return slot;
	}

	async unload() {
		this.unloadGeneration++;
		const slot = this.takeIdle();
		if (slot) await this.close(slot.engine);
	}
}

class Dictation implements Recognizer {
	readonly traits: Traits;
	private readonly stopped = new AbortController();
	private readonly signal: Signal;
	private readonly hash = createHash("sha256");
	private readonly chunks?: PauseChunks;
	private through = 0;
	private raw = "";
	private busy = false;
	private ended = false;
	private release?: Promise<void>;
	private readonly lease: Lease;
	private readonly route: Route;
	private readonly language: SpeechLanguage;
	private readonly nativeBias: boolean;
	private readonly idle: Idle;
	private readonly onText: (update: WordUpdate) => void;
	private readonly observe: (event: Observation) => void;
	private readonly giveBack: () => void;
	private readonly owner: Signal;

	constructor(lease: Lease, route: Route, language: SpeechLanguage, nativeBias: boolean, idle: Idle, onText: (update: WordUpdate) => void,
		observe: (event: Observation) => void, giveBack: () => void, owner: Signal) {
		this.lease = lease;
		this.route = route;
		this.language = language;
		this.nativeBias = nativeBias;
		this.idle = idle;
		this.onText = onText;
		this.observe = observe;
		this.giveBack = giveBack;
		this.owner = owner;
		this.traits = lease.engine.traits;
		this.signal = AbortSignal.any([owner, this.stopped.signal]);
		if (route === "chunks") this.chunks = new PauseChunks(lease.engine.maxInputSamples);
		this.owner.addEventListener("abort", this.cancel, { once: true });
		if (this.owner.aborted) this.cancel();
	}

	private cancel = () => { void this.abort().catch(() => {}); };

	private async settle(good: boolean) {
		this.ended = true;
		this.owner.removeEventListener("abort", this.cancel);
		this.release ??= this.lease.release(good, this.idle, this.signal).finally(this.giveBack);
		return this.release;
	}

	async abort() {
		this.stopped.abort();
		await this.settle(false);
	}

	private async run<T>(signal: Signal, work: (active: Signal) => Promise<T>) {
		if (this.busy || this.ended) throw new Error("The selected recognizer is busy or ended.");
		const active = AbortSignal.any([signal, this.signal]);
		this.busy = true;
		try {
			active.throwIfAborted();
			const result = await work(active);
			active.throwIfAborted();
			return result;
		} catch (error) {
			this.observe({ kind: "failed" });
			await this.abort();
			throw error;
		} finally { this.busy = false; }
	}

	private async decode(from: number, pcm: Buffer, signal: Signal) {
		const text = await nativeBatch(this.lease.engine, pcm, this.language, from, this.observe, signal);
		this.raw = joinChunks(this.raw, normalizeTranscript(text));
	}

	async push(from: number, pcm: Uint8Array, signal: Signal, catchUp = false) {
		return this.run(signal, async (active) => {
			if (from !== this.through || pcm.byteLength % 2) throw new Error("The selected recognizer requires contiguous 16-bit PCM.");
			if (!pcm.byteLength) return;
			const block = Buffer.from(pcm);
			if (this.route === "stream") {
				// The growing WAV reader caps each read at one second. A full
				// second in one read is backlog work: advance the real decoder and
				// wait for its ACK, but do not publish the stale intermediate draft.
				const draining = catchUp || block.length >= 2 * RATE;
				const updates = await this.lease.engine.feed(from, block, false, active, draining);
				active.throwIfAborted();
				if (!draining) for (const update of updates) if (update.kind === "draft") { active.throwIfAborted(); this.onText(update); }
			} else if (this.chunks) await this.chunks.append(block, (offset, chunk) => this.decode(offset, chunk, active));
			this.hash.update(block);
			this.through += block.length / 2;
		});
	}

	async finish(audio: VerifiedAudio, signal: Signal) {
		return this.run(signal, async (active) => {
			const engine = this.lease.engine;
			const final = await withVerifiedPcm(audio, active, async (file) => {
				const inputPcmSha256 = this.hash.copy().digest("hex");
				if (this.through !== file.total || inputPcmSha256 !== await file.digest(active)) throw invalidRecognitionAudio("the complete take does not match the PCM supplied to recognition");
				this.observe({ kind: "snapshot", samples: file.total, pcmSha256: inputPcmSha256 });
				if (this.route === "stream") {
					const result = await engine.feed(this.through, EMPTY, true, active);
					const end = result.at(-1);
					if (!end || end.kind !== "commit" || end.from !== 0 || end.to !== this.through) throw new Error("The selected recognizer did not finalize the complete stream.");
					assertReceipt(engine.evidence(), this.through, inputPcmSha256);
					this.raw = end.text;
				} else if (this.chunks) {
					await this.chunks.finish((offset, chunk) => this.decode(offset, chunk, active));
				} else if (this.route === "long-form") this.raw = await engine.batchFile!(audio, active);
				else {
					if (file.total > engine.maxInputSamples) throw new Error("The take exceeds the loaded model's whole-file limit. Enable chunking for long takes.");
					await this.decode(0, await file.read(0, file.total, active), active);
				}
				return { final: finalText(this.raw, this.language, "live", this.nativeBias), inputPcmSha256 };
			});
			this.observe({ kind: "final", ...final, evidence: engine.evidence(), inputSamples: this.through });
			await this.settle(true);
			active.throwIfAborted();
			if (this.route === "stream") this.onText({ kind: "commit", from: 0, to: this.through, text: final.final.raw });
			return final.final;
		});
	}
}

function assertReceipt(evidence: Evidence, samples: number, hash: string) {
	if (evidence.inputSamples !== samples || evidence.inputPcmSha256 !== hash) throw new Error("The recognizer did not confirm the exact PCM input.");
}

async function nativeBatch(engine: NativeEngine, pcm: Buffer, language: SpeechLanguage, from: number, observe: (event: Observation) => void, signal: Signal) {
	const text = await engine.batch(pcm, language, signal);
	signal.throwIfAborted();
	const evidence = engine.evidence();
	assertReceipt(evidence, pcm.length / 2, createHash("sha256").update(pcm).digest("hex"));
	observe({ kind: "batch", from, to: from + pcm.length / 2, text, evidence });
	return text;
}

function whisperChoice(model: ReturnType<typeof legacyModels>[number], choice: Choice) {
	const en = isEnglishOnlyWhisperModelName(model.name);
	if (choice.requestedDeviceId !== null || !["auto", "cpu"].includes(choice.compute) || choice.detector !== "off") {
		throw new Error("This installed whisper.cpp file route supports Auto or CPU and no separate speech detector.");
	}
	if (choice.task === "translate-en" && (en || isTranslationUnsupportedWhisperModelName(model.name))) throw new Error("This Whisper model cannot translate to English.");
	if (en && choice.language !== "en" && choice.language !== "auto") throw new Error("The selected Whisper model is English-only.");
	return { ...choice, language: en ? "en" : choice.language };
}

export function assertInteractiveArtifactBackend(variantId: string) {
	if (getTranscribeBackend() === "whisper.cpp" && !whisperVariants().some(({ row }) => row.id === variantId)) {
		throw new Error("MICME_TRANSCRIBE_BACKEND=whisper.cpp cannot use the selected artifact. Clear MICME_ARTIFACT to use Whisper, or select the Auto backend to use this artifact.");
	}
}

export function createRecognitionService(options: ServiceOptions = {}) {
	const observe = (event: Observation) => options.observe && publish(options.observe, event);
	const settings = options.settings ?? getTransferOptions;
	const queue = options.queue ?? new RecognitionQueue();
	const cliQueue = new RecognitionQueue();
	const load = options.load ?? loadInstalledNative;
	const pool = new ModelPool(load, observe);
	const cliPool = new ModelPool(load, observe);

	const openRecognizer: OpenRecognizer = async (requested, onText, signal) => {
		const choice = { ...requested };
		const prefs = settings();
		assertInteractiveArtifactBackend(choice.variantId);
		const giveBack = await queue.acquire("foreground", signal);
		let lease: Lease | undefined;
		try {
			lease = await pool.acquire(choice, signal);
			const engine = lease.engine;
			const route = loadedRecognitionRoute(choice, engine);
			const language = takeLanguage(choice, engine, prefs.MICME_PREFERRED_LANGUAGES);
			const words = engine.traits.bias ? prefs.MICME_WORDS : [];
			if (route === "stream") await engine.begin(language, words, signal);
			signal.throwIfAborted();
			return new Dictation(lease, route, language, route === "stream" && words.length > 0, prefs.MICME_MODEL_IDLE, onText, observe, giveBack, signal);
		} catch (error) {
			try { await lease?.release(false, "immediate", signal); } finally { giveBack(); }
			throw error;
		}
	};

	async function recognizeFile(audio: VerifiedAudio, requested: Choice, job: FileJob, progress: (through: number, total: number) => void, signal: Signal,
		fileOptions: FileOptions = {}): Promise<RecognizedFile> {
		signal.throwIfAborted();
		const choice = { ...requested };
		const prefs = settings();
		const runQueue = job === "cli" ? cliQueue : queue;
		const runPool = job === "cli" ? cliPool : pool;
		const priority = job === "cli" ? "foreground" : job;
		const legacy = options.load ? undefined : legacyModels().find(({ id }) => id === choice.variantId);
		const selected = legacy ? whisperChoice(legacy, choice) : choice;
		let highWater = 0;
		return withVerifiedPcm(audio, signal, async (file) => {
			const onProgress = (through: number) => {
				signal.throwIfAborted();
				if (through > highWater) { highWater = through; progress(through, file.total); }
			};
			const context: FileContext = { file, queue: runQueue, pool: runPool, priority, signal, prefs, observe, onProgress,
				whole: job === "cli" && fileOptions.whole === true, legacy };
			try {
				return await fileAttempt(context, selected, job === "retry");
			} catch (error) {
				signal.throwIfAborted();
				// One fresh same-model attempt is the retry. CPU is allowed only for
				// unpinned Auto, an inference failure, and a host that labels the change.
				if (!(error instanceof RetryableInference) || job !== "retry" || selected.compute !== "auto" ||
					selected.requestedDeviceId !== null || !fileOptions.onCpuRecovery) throw error;
				fileOptions.onCpuRecovery();
				signal.throwIfAborted();
				return fileAttempt(context, { ...selected, compute: "cpu" }, true);
			}
		});
	}

	const unload: Unload = async () => { await Promise.all([pool.unload(), cliPool.unload()]); };
	return { openRecognizer, recognizeFile, unload };
}

class RetryableInference extends Error {
	constructor(cause: unknown) { super("Local inference failed before a complete result.", { cause }); }
}

type FileContext = {
	file: VerifiedPcm; queue: RecognitionQueue; pool: ModelPool; priority: "foreground" | "retry" | "import"; signal: Signal;
	prefs: ReturnType<NonNullable<ServiceOptions["settings"]>>; observe: (event: Observation) => void; onProgress: (through: number) => void;
	whole: boolean; legacy?: ReturnType<typeof legacyModels>[number];
};

async function fileAttempt(context: FileContext, choice: Choice, fresh: boolean): Promise<RecognizedFile> {
	const { file, queue, pool, priority, signal, prefs, observe, legacy } = context;
	const input = createHash("sha256");
	let actualCompute: Traits["actualCompute"] = "unknown";
	let boundDevice: DeviceIdentity | null = null;
	let language = choice.language;
	let raw = "";
	let bindingObserved = false;
	let evidence: Evidence | null = null;
	const decode = async (from: number, pcm: Buffer) => {
		const unlock = await queue.acquire(priority, signal);
		let lease: Lease | undefined;
		let good = false;
		try {
			signal.throwIfAborted();
			let text: string;
			let compute: Traits["actualCompute"];
			let device: DeviceIdentity | null;
			if (legacy) {
				const result = await whisperChunk(legacy, file, pcm, choice, signal);
				({ text, actualCompute: compute, boundDevice: device } = result);
			} else {
				lease = await pool.acquire(choice, signal, fresh && from === 0);
				const { engine } = lease;
				loadedRecognitionRoute(choice, engine);
				assertLoadedBinding(choice, engine.traits);
				language = takeLanguage(choice, engine, prefs.MICME_PREFERRED_LANGUAGES);
				if (!engine.traits.batch || pcm.length / 2 > engine.maxInputSamples) throw new Error("The loaded model cannot recognize this bounded whole-file input.");
				try { text = await nativeBatch(engine, pcm, language, from, observe, signal); }
				catch (error) { throw new RetryableInference(error); }
				evidence = engine.evidence();
				({ actualCompute: compute, boundDevice: device } = engine.traits);
			}
			signal.throwIfAborted();
			if (!legacy || hasNonzeroPcm(pcm)) {
				if (bindingObserved && (actualCompute !== compute || !sameDevice(boundDevice, device))) throw new Error("Loaded compute binding changed during file recognition.");
				bindingObserved = true;
				actualCompute = compute;
				boundDevice = device;
			}
			raw = joinChunks(raw, normalizeTranscript(text));
			input.update(pcm);
			good = true;
		} finally {
			const moreChunks = from + pcm.length / 2 < file.total;
			const idle = moreChunks && prefs.MICME_MODEL_IDLE === "immediate" ? "5min" : prefs.MICME_MODEL_IDLE;
			try { await lease?.release(good, idle, signal); }
			finally { unlock(); }
		}
		context.onProgress(from + pcm.length / 2);
	};
	try {
		if (context.whole) {
			// Comparator only; bound allocation independently of the supplied file.
			if (file.total > 120 * RATE) throw invalidRecognitionAudio("the whole-file comparator exceeds 120 seconds");
			await decode(0, await file.read(0, file.total, signal));
		} else {
			const chunks = new PauseChunks(40 * RATE);
			for (let from = 0; from < file.total; from += RATE) {
				await chunks.append(await file.read(from, Math.min(RATE, file.total - from), signal), decode);
			}
			await chunks.finish(decode);
		}
		const final = finalText(raw, language, "import", false);
		observe({ kind: "final", final, evidence, inputSamples: file.total, inputPcmSha256: input.digest("hex") });
		return { ...final, actualCompute, boundDevice };
	} finally {
		if (prefs.MICME_MODEL_IDLE === "immediate" && !context.whole) await pool.unload();
	}
}

async function whisperChunk(legacy: ReturnType<typeof legacyModels>[number], file: VerifiedPcm, pcm: Buffer, choice: Choice, signal: Signal) {
	if (!hasNonzeroPcm(pcm)) return { text: "", actualCompute: "unknown", boundDevice: null } as const;
	return file.withChunk(pcm, signal, (path) => transcribeInstalledWhisper(legacy.binary, legacy.path, path, file.directory, choice, signal));
}

const installed = createRecognitionService({ queue: recognitionQueue, observe: notifyObservers });
export const openRecognizer = installed.openRecognizer;
export const recognizeFile: RecognizeFile = installed.recognizeFile;
export function recognizeVerifiedRetry(audio: VerifiedAudio, choice: Choice, progress: Parameters<RecognizeFile>[3], signal: Signal, onCpuRecovery: () => void) {
	return installed.recognizeFile(audio, choice, "retry", progress, signal, { onCpuRecovery });
}
export const unload = installed.unload;
