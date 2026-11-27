import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { cpus, release } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RATE, sha256, wavHeader } from "./corpus.mjs";
import { fixtureFiles, pcmFromWav } from "./transfer-fixtures.mjs";
import { emptyTake } from "./transfer-runner.mjs";
import { HandyGap, launchHandy, loopbackSource, namespaces, privateDisplay, verifyTools } from "./transfer-handy-driver.mjs";

export const handyTag = "v0.10.2";
export const handyCommit = "a822741f9c697b6f6a00c557e4817bf59ae70867";
const digest = /^[0-9a-f]{64}$/u;
const modelName = /^[a-z0-9][a-z0-9_.-]{0,239}\.(?:bin|gguf)$/iu;
const modelId = /^[a-z0-9][a-z0-9_./-]{0,239}$/iu;
const negative = new Set(["silence", "noise", "immediate"]);
// The immutable P1 slots name the private monitor condition, not its Pulse source name.
const frozenMonitor = "private PulseAudio monitor (planned)";
const maxWavBytes = 64 * 1024 * 1024;
const sileroSha256 = "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6";

function planInputs(t, local) {
	if (t.product !== "handy-0102" || t.build.tag !== handyTag || t.build.commit !== handyCommit) {
		throw new HandyGap("identity-mismatch", "Pin Handy v0.10.2 and its exact tagged commit in the frozen build.");
	}
	if (![local?.handyBinary, local?.assetsDir, local?.workDir].every((p) => typeof p === "string" && isAbsolute(p)) ||
		![t.build.binarySha256, t.build.modelSha256, t.pcmSha256].every((h) => digest.test(h))) {
		throw new HandyGap("missing-input", "Supply absolute Handy binary, public fixture and work paths, plus frozen binary, weight and PCM digests.");
	}
	const weights = local.handyModelFiles?.filter((entry) => entry.sha256 === t.build.modelSha256) ?? [];
	const file = basename(t.build.modelFile ?? "");
	if (!local.handyModelFiles?.length || !file) throw new HandyGap("missing-input", "Supply the exact frozen Handy weight filename and its local catalog ID, path and digest.");
	if (weights.length !== 1 || !isAbsolute(weights[0].file) || !modelName.test(file) || !modelId.test(weights[0].catalogId)) {
		throw new HandyGap("identity-mismatch", "The sidecar does not uniquely supply the exact frozen Handy weight and catalog ID; no alternate selected.");
	}
	if (!Object.hasOwn(fixtureFiles, t.fixture)) throw new HandyGap("missing-input", "Supply a planned public WAV fixture.");
	const pcm = t.track === "pcm";
	if (t.input === "physical") throw new HandyGap("unsupported", "Handy reference trials never use the physical microphone.");
	if ((pcm && (t.input !== "file" || t.target !== "none" || t.gesture !== "none")) ||
		(!pcm && (t.input !== "loopback" || t.gesture !== "toggle" || !["external-editor", "none"].includes(t.target) ||
			(t.track === "destination" && t.target !== "external-editor")))) {
		throw new HandyGap(t.target === "pi-prompt" || (t.track === "destination" && t.target === "none") ? "no-observer" : "unsupported",
			"Use file/no target/no gesture for Handy PCM, or private loopback with a toggle and the controlled external editor for desktop.");
	}
	if (t.processing !== "off" || t.cache !== "cold-process" || t.disk === "cold-proven" || t.load !== "idle" ||
		![null, "auto", "cpu"].includes(t.rig.requestedDevice) || t.rig.threads !== null) {
		throw new HandyGap("unsupported", "Only cold-process idle runs, without claimed cold disk, explicit thread count, GPU, or polish, are provisioned by this collector.");
	}
	if ((t.prefix ?? "").length > 8192 || (t.language !== null && !/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/iu.test(t.language)) ||
		![null, "off", "silero", "earshot"].includes(t.build.vad) || ![null, "off", "on", "default", "pause-aware"].includes(t.build.chunkPolicy)) {
		throw new HandyGap("unsupported", "The frozen receiver prefix, language, VAD or chunk policy cannot be applied to this Handy release.");
	}
	return { pcm, model: weights[0], file };
}

async function openInput(path, signal) {
	signal.throwIfAborted();
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		if ((await file.stat()).isFile()) return file;
		await file.close();
		throw new HandyGap("identity-mismatch", "A provisioned path is not a regular file.");
	} catch (error) {
		if (error.code === "ELOOP") throw new HandyGap("identity-mismatch", "Supply regular leaf files, not symlinks, for pinned inputs.");
		if (error.code === "EACCES" || error.code === "EPERM") throw new HandyGap("missing-permission", "The collector cannot read a pinned local input.");
		if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new HandyGap("missing-input", "A pinned local input is absent.");
		throw error;
	}
}

async function copyPinned(input, output, size, signal) {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(1 << 20);
	let offset = 0;
	while (offset < size) {
		signal.throwIfAborted();
		const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
		if (!bytesRead) break;
		hash.update(buffer.subarray(0, bytesRead));
		let wrote = 0;
		while (wrote < bytesRead) {
			const { bytesWritten } = await output.write(buffer, wrote, bytesRead - wrote, offset + wrote);
			if (!bytesWritten) throw new HandyGap("no-result", "Could not write the private staging file.", "failed");
			wrote += bytesWritten;
		}
		offset += bytesRead;
	}
	return offset === size && (await input.read(buffer, 0, 1, offset)).bytesRead === 0 ? hash.digest("hex") : null;
}

async function stageInput(source, destination, expected, signal, { executable = false } = {}) {
	const input = await openInput(source, signal);
	try {
		const { size } = await input.stat();
		if (executable) {
			const header = Buffer.alloc(4);
			await input.read(header, 0, 4, 0);
			if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new HandyGap("identity-mismatch", "Supply the installed v0.10.2 Linux ELF, not a launcher or wrapper.");
		}
		const output = await open(destination, "wx", executable ? 0o500 : 0o400);
		try {
			if (await copyPinned(input, output, size, signal) !== expected) {
				throw new HandyGap("identity-mismatch", executable ? "Handy executable SHA-256 does not match the frozen build." : "Handy weight SHA-256 does not match the frozen build.");
			}
		} finally { await output.close(); }
	} finally { await input.close(); }
}

async function stageFixture(local, trial, dir, signal) {
	const source = await openInput(join(local.assetsDir, fixtureFiles[trial.fixture]), signal);
	let pcm;
	try {
		const { size } = await source.stat();
		if (size > maxWavBytes) throw new HandyGap("identity-mismatch", "Public WAV exceeds the bounded replay fixture size.");
		const bytes = Buffer.alloc(size + 1);
		let bytesRead = 0;
		while (bytesRead < bytes.length) {
			signal.throwIfAborted();
			const chunk = await source.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
			if (!chunk.bytesRead) break;
			bytesRead += chunk.bytesRead;
		}
		try { pcm = pcmFromWav(bytes.subarray(0, bytesRead)); } catch {
			throw new HandyGap("identity-mismatch", "Public fixture is not a complete mono 16 kHz PCM16 WAV.");
		}
		if (bytesRead !== size || sha256(pcm) !== trial.pcmSha256 || (trial.fixture === "immediate" && (pcm.length !== 640 || pcm.some(Boolean)))) {
			throw new HandyGap("identity-mismatch", "Prepared fixture changed or does not match the frozen public PCM digest and expected format.");
		}
	} finally { await source.close(); }
	await writeFile(join(dir, "fixture.wav"), Buffer.concat([wavHeader(pcm.length), pcm]), { flag: "wx", mode: 0o400, signal });
	return pcm.length;
}

async function workspace(workDir) {
	let parent;
	try { parent = await realpath(workDir); } catch (error) {
		throw new HandyGap(error.code === "EACCES" ? "missing-permission" : "missing-input", "Supply an accessible disposable benchmark work directory.");
	}
	const info = await stat(parent);
	if (!info.isDirectory() || ((info.mode & 0o022) && !(info.mode & 0o1000))) {
		throw new HandyGap("unsafe-instance", "The benchmark work root may be modified by unrelated users; supply a private or sticky directory.");
	}
	const dir = await mkdtemp(join(parent, "handy-reference-"));
	return { dir, identity: await lstat(dir) };
}

async function cleanup(owned) {
	if (!owned) return;
	const { dir, identity } = owned;
	const current = await lstat(dir).catch(() => null);
	if (current?.dev === identity.dev && current.ino === identity.ino && current.isDirectory()) {
		await rm(dir, { recursive: true, force: true });
	}
}

async function packageResources(binary, validateVad, dir, signal) {
	// Use only the runtime/resources adjoining the explicitly supplied installed
	// release (deb/rpm layout). Don't borrow an unrelated system installation.
	const expected = resolve(await realpath(dirname(binary)), "../lib/Handy");
	try {
		if (await realpath(expected) !== expected || !(await stat(expected)).isDirectory()) throw new Error();
		await access(join(expected, "resources", "handy.png"), constants.R_OK);
	} catch (error) {
		throw new HandyGap(error.code === "EACCES" ? "missing-permission" : "missing-host", "Supply the installed Linux release with its adjoining lib/Handy package resources and native runtime.");
	}
	if (validateVad) {
		await stageInput(join(expected, "resources", "models", "silero-vad-v6.2-F32.gguf"), join(dir, "silero"), sileroSha256, signal);
	}
	return expected;
}

function localRig(trial) {
	if (![null, privateDisplay, "x11"].includes(trial.rig.display)) {
		throw new HandyGap("identity-mismatch", "The frozen display does not match the private Xvfb/X11 display.");
	}
	if (trial.rig.mic !== null && (trial.track === "pcm" || ![frozenMonitor, loopbackSource].includes(trial.rig.mic))) {
		throw new HandyGap("identity-mismatch", "The frozen audio source does not match the private PulseAudio loopback.");
	}
	const host = { os: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? null, hostVersion: release() };
	for (const [key, value] of Object.entries(host)) {
		if (trial.rig[key] !== null && trial.rig[key] !== value) throw new HandyGap("identity-mismatch", "The frozen operating system, CPU or host version differs from this reference rig.");
	}
	return { ...host, display: trial.rig.display ?? privateDisplay };
}

function startupOutcome(error) {
	if (error?.name === "AbortError") return new HandyGap("canceled", "Reference collection canceled; no personal resources were used.", "lost");
	if (error instanceof HandyGap) return error;
	if (error?.code === "EACCES" || error?.code === "EPERM") return new HandyGap("missing-permission", "The host denied access to an isolated benchmark resource.");
	return new HandyGap("no-result", "Reference collection failed without a usable result; no personal resources were used.", "failed");
}

// Only the private driver emits stamps. All are from one monotonic clock, with
// zero at the actual file launch/SIGUSR2. No app-reported duration becomes an event.
export function projectHandyTake(trial, observations, bytes, observedRig) {
	const last = observations.findLast((o) => o.kind === "result");
	const take = emptyTake(trial, last?.outcome ?? "failed", last?.code ?? "no-result", last?.detail ?? "The owned Handy driver did not return a complete result.");
	const start = observations.find((o) => o.stage === "trigger")?.ns;
	if (start === undefined) return take;
	take.trial = { ...trial, rig: { ...trial.rig, ...observedRig } };
	if (last?.outcome === "completed") take.gaps = [];
	const ms = (o) => Number(BigInt(o.ns) - BigInt(start)) / 1e6;
	take.events = observations.filter((o) => o.kind === "event").map((o) => ({ stage: o.stage, ms: ms(o) }));
	take.mutations = observations.filter((o) => o.kind === "mutation").map((o) => ({ ms: ms(o), text: o.text }));
	take.pcmBytes = bytes; // Verified public replay source, not Handy's processed capture.
	take.audioMs = bytes / (2 * RATE) * 1e3;
	const binding = observations.findLast((o) => o.kind === "binding");
	const backend = binding?.backend?.toLowerCase();
	take.trial.rig.actualBackend = ["cpu", "vulkan", "metal"].includes(backend) ? backend : "unknown";
	take.trial.rig.actualDevice = binding?.device && binding.device !== "default" ? { id: null, label: binding.device } : null;
	const streamGap = trial.track === "pcm" || binding?.streaming === false ? "unsupported" : "no-observer";
	for (const stage of ["firstUseful", "firstEndpoint"]) {
		take.gaps.push({ stage, code: streamGap, detail: streamGap === "unsupported" ? "The whole-file CLI or loaded batch model does not expose live preview on this route." : "No verified overlay/worker-endpoint observer on this Handy route." });
	}
	take.gaps.push({ stage: "rawFinal", code: "no-observer", detail: "The stock release exposes a locally finished final, not text before Handy's local normalization." });
	take.cleaned = last?.text ?? null;
	take.computeMs = last?.computeMs ?? null;
	if (trial.track === "pcm" && last?.consumed === true) {
		take.fedBytes = bytes;
		take.fedSha256 = trial.pcmSha256;
	}
	if (trial.track !== "pcm") projectReceiver(take, last, observations);
	take.events.sort((a, b) => a.ms - b.ms);
	return take;
}

function projectReceiver(take, result, observations) {
	if (observations.some((o) => o.kind === "idleAudio")) take.idleMicOpen = false;
	const plannedMic = take.trial.rig.mic;
	const route = observations.findLast((o) => o.kind === "route");
	if (route?.source === loopbackSource) {
		take.trial.rig.mic = plannedMic === frozenMonitor ? frozenMonitor : route.source;
	} else {
		take.trial.rig.mic = null;
		take.events = take.events.filter(({ stage }) => stage !== "firstSample");
		take.gaps.push({ stage: "firstSample", code: route?.source ? "identity-mismatch" : "no-observer",
			detail: "No confirmed owned Handy source-output on the private loopback was observed during recording." });
		// An unpinned immediate-stop control deliberately does not wait for a stream.
		if (take.outcome === "completed" && (plannedMic !== null || take.trial.fixture !== "immediate" || route)) take.outcome = "failed";
	}
	take.gaps.push({ stage: "readyCue", code: "no-observer", detail: "Handy's sample log is not a witnessed overlay or audible cue." });
	const last = take.mutations.at(-1);
	const prefix = take.trial.prefix ?? "";
	if (!observations.some((o) => o.kind === "receiver")) return;
	take.observedTarget = result?.observedTarget ?? last?.text ?? prefix;
	take.sentCount = observations.filter((o) => o.kind === "submit").length;
	take.queuedCount = 0; // Owned plain-text field has no submit queue.
	if (last && take.observedTarget.startsWith(prefix)) take.delivered = take.observedTarget.slice(prefix.length);
	if (take.trial.target !== "external-editor") return;
	const expected = negative.has(take.trial.fixture) ? "" : result?.text;
	if (expected != null) {
		take.expectedTarget = prefix + expected;
		const hit = expected && take.mutations.find((frame) => frame.text === take.expectedTarget);
		if (hit) take.events.push({ stage: "correctTarget", ms: hit.ms });
		if (expected) {
			const suffix = take.delivered;
			if (suffix && suffix.length % expected.length === 0 && expected.repeat(suffix.length / expected.length) === suffix) {
				take.duplicateInsertions = suffix.length / expected.length - 1;
				take.staleInsertions = 0;
			}
		} else if (!last) take.duplicateInsertions = take.staleInsertions = 0;
	}
	if (take.expectedTarget === null) take.gaps.push({ stage: "correctTarget", code: "no-observer", detail: "No independent private Handy final was available to compare with the actual editor field." });
}

export async function collect(trial, signal = AbortSignal.timeout(180_000), context = {}) {
	let owned;
	try {
		signal.throwIfAborted();
		const { local } = context;
		const inputs = planInputs(trial, local);
		if (process.platform !== "linux" || process.getuid() === 0) throw new HandyGap("missing-host", "Run the isolated Linux reference as a normal user, not as root.");
		const rig = localRig(trial);
		owned = await workspace(local.workDir);
		const { dir } = owned;
		await mkdir(join(dir, "state"), { mode: 0o700 });
		await stageInput(local.handyBinary, join(dir, "handy"), trial.build.binarySha256, signal, { executable: true });
		await stageInput(inputs.model.file, join(dir, "model"), trial.build.modelSha256, signal);
		const bytes = await stageFixture(local, trial, dir, signal);
		const vad = !inputs.pcm && !["off", "earshot"].includes(trial.build.vad);
		const resources = await packageResources(local.handyBinary, vad, dir, signal);
		await verifyTools(inputs.pcm);
		const ns = await Promise.all(namespaces.map((name) => readlink(`/proc/self/ns/${name}`)));
		const observations = await launchHandy({ dir, resources, signal, spec: {
			ns, pcm: inputs.pcm, bytes, fixture: trial.fixture, modelFile: inputs.file, modelId: inputs.model.catalogId,
			modelDigest: trial.build.modelSha256, modelRevision: trial.build.modelRevision,
			language: trial.language ?? "auto", translate: trial.task === "translate-en", requestedDevice: trial.rig.requestedDevice,
			width: trial.width ?? 80, prefix: trial.prefix ?? "", pinSilero: vad,
			vad: trial.build.vad, chunk: trial.build.chunkPolicy,
		} });
		return projectHandyTake(trial, observations, bytes, rig);
	} catch (error) {
		const gap = startupOutcome(signal.aborted ? new DOMException("Canceled", "AbortError") : error);
		return emptyTake(trial, gap.outcome, gap.code, gap.message);
	} finally { await cleanup(owned); }
}
