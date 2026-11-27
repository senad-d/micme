import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, join, sep } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(import.meta.url);
const repo = fileURLToPath(new URL("../", import.meta.url));
const unix = { skip: process.platform === "win32" && "V5 POSIX command fixtures", timeout: 120_000 };
const { TRANSCRIBE_CLI_FLAGS: K, TRANSCRIBE_CLI_EXIT: status, MICME_TRANSFER_ACTIONS } = await import("../src/transfer/contracts.ts");
const fixtureText = "fixture transcript";
const firstDevice = { id: "fixture-vulkan:1", label: "Fixture One" };
const secondDevice = { id: "fixture-vulkan:2", label: "Fixture Two" };
const devices = [{ backend: "vulkan", device: firstDevice }, { backend: "vulkan", device: secondDevice }, { backend: "cpu", device: null }];

async function run(file, args, options) {
	const child = spawn(file, args, { signal: AbortSignal.timeout(60_000), stdio: ["ignore", "pipe", "pipe"], ...options });
	let stdout = "", stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const [status, signal] = await once(child, "close");
	assert.equal(signal, null, `${file} terminated by ${signal}\n${stderr}`);
	return { status, stdout, stderr };
}

function succeeded(result, context) {
	assert.equal(result.status, 0, `${context}\n${result.stderr}\n${result.stdout}`);
	return result.stdout;
}

function wave(samples, { rate = 16000, channels = 1, bits = 16, format = 1, marker = 7000 } = {}) {
	const align = channels * bits / 8;
	const bytes = Buffer.alloc(44 + samples * align);
	bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(format, 20); bytes.writeUInt16LE(channels, 22);
	bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * align, 28); bytes.writeUInt16LE(align, 32);
	bytes.writeUInt16LE(bits, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * align, 40);
	if (bits === 16) for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(marker * (i % 16 < 8 ? 1 : -1), i);
	return bytes;
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function modelNamed(id, name) {
	return id === name || id.endsWith(`:${name}`) || basename(id) === `ggml-${name}.bin` || id.startsWith(`whisper.cpp/${name}/`);
}

function pcmFormat(bytes) {
	assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
	assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
	for (let at = 12; at + 8 <= bytes.length;) {
		const size = bytes.readUInt32LE(at + 4);
		if (bytes.toString("ascii", at, at + 4) === "fmt ") {
			const encoding = bytes.readUInt16LE(at + 8);
			const subtype = encoding === 0xfffe && size >= 40 ? bytes.readUInt32LE(at + 32) : encoding;
			return [subtype, bytes.readUInt16LE(at + 10), bytes.readUInt32LE(at + 12), bytes.readUInt16LE(at + 22)];
		}
		at += 8 + size + (size % 2);
	}
	assert.fail("published WAVE contains no format chunk");
}

async function log(root) {
	const text = await readFile(join(root, "calls"), "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
		return "";
	});
	return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function until(get, description) {
	const deadline = performance.now() + 12_000;
	while (performance.now() < deadline) {
		const result = await get();
		if (result) return result;
		await delay(20);
	}
	assert.fail(`Did not observe ${description}`);
}

// Preloaded before production modules. Log attempts even if product code catches the exception.
const preload = `
import { appendFileSync } from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.V5_ROOT;
const require = createRequire(import.meta.url);
function forbidden(kind) {
  appendFileSync(join(root, "forbidden"), kind + "\\n");
  throw new Error("V5 forbidden effect: " + kind);
}
globalThis.fetch = () => forbidden("fetch");
for (const [name, keys] of [["http", ["request", "get"]], ["https", ["request", "get"]], ["net", ["connect", "createConnection"]], ["tls", ["connect"]]]) {
  for (const key of keys) require("node:" + name)[key] = () => forbidden(name + "." + key);
}
require("node:net").Socket.prototype.connect = () => forbidden("socket.connect");
syncBuiltinESMExports();
const engine = pathToFileURL(join(root, "device-fixture.mjs")).href;
const delivery = "data:text/javascript," + encodeURIComponent(
  "import { appendFileSync } from 'node:fs'; export function pasteOrSubmitTranscript() {" +
  "appendFileSync(" + JSON.stringify(join(root, "forbidden")) + ", 'prompt delivery\\\\n'); throw new Error('V5 forbids delivery'); }"
);
registerHooks({
  resolve(specifier, context, next) {
    if (process.env.V5_INSTALLED && /(?:^|\\/)(?:pi-coding-agent|pi-tui)(?:\\/|$)/.test(specifier)) forbidden("Pi peer");
    const result = next(specifier, context);
    if (/\\/transcript-delivery\\.(?:m?js|ts)$/.test(result.url)) return { url: delivery, shortCircuit: true };
    if (process.env.V5_DEVICES && /\\/transfer\\/recognition\\.(?:m?js|ts)$/.test(result.url)) {
      // Replace only E's device/ASR responses; installed-model discovery is still real.
      return { ...result, url: result.url + "?v5-devices" };
    }
    return result;
  },
  load(url, context, next) {
    if (!url.endsWith("?v5-devices")) return next(url, context);
    return { format: "module", shortCircuit: true, source:
      "export * from " + JSON.stringify(url.replace("?v5-devices", "?v5-real")) + ";" +
      "export { listCompute, recognizeFile } from " + JSON.stringify(engine) + ";" };
  }
});
`;
const whisper = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const root = process.env.V5_ROOT;
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("-f")) {
  if (process.argv.includes("--help") || process.argv.includes("--version")) process.exit(0);
  throw new Error("Expected an audio file in the fixture decoder");
}
const audio = readFileSync(arg("-f"));
if (audio.toString("ascii", 0, 4) !== "RIFF") throw new Error("Expected normalized WAV input");
appendFileSync(join(root, "calls"), JSON.stringify({ pid: process.pid, model: basename(arg("-m")), bytes: audio.length }) + "\\n");
while (existsSync(join(root, "hold")) && !existsSync(join(root, "release-" + process.pid))) await delay(15);
writeFileSync(arg("-of") + ".txt", ${JSON.stringify(fixtureText + "\n")});
`;
const deviceFixture = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export async function listCompute() { return ${JSON.stringify(devices)}; }
export async function recognizeFile(audio, choice, job) {
  appendFileSync(join(process.env.V5_ROOT, "calls"), JSON.stringify({ choice, job, sha256: audio.sha256 }) + "\\n");
  const observed = ${JSON.stringify([firstDevice, secondDevice])}.find(d => d.id === process.env.V5_OBSERVED) ?? null;
  return { raw: "${fixtureText}", local: "${fixtureText}", language: "en", source: "clip", rules: [],
    actualCompute: process.env.V5_ACTUAL_COMPUTE, boundDevice: observed };
}
`;

async function executable(name) {
	for (const path of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const candidate = join(path, name);
		if (await access(candidate).then(() => true, () => false)) return realpath(candidate);
	}
	assert.fail(`V5 mixed-media fixtures require ${name} on PATH`);
}

async function fixture(t, { media = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "micme-v5-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const agent = join(root, "agent");
	const project = join(root, "project");
	const models = join(project, "models");
	const scratch = join(root, "scratch");
	const home = join(root, "home");
	const cache = join(root, "managed-cache");
	await Promise.all([bin, agent, project, scratch, home, cache].map((path) => mkdir(path, { mode: 0o700 })));
	await mkdir(models, { mode: 0o700 });
	const trap = join(root, "offline.mjs");
	const hook = join(bin, "output-hook");
	await Promise.all([
		writeFile(trap, preload), writeFile(join(root, "device-fixture.mjs"), deviceFixture),
		writeFile(join(models, "ggml-tiny.en.bin"), "fixture model A"), writeFile(join(models, "ggml-base.en.bin"), "fixture model B"),
		writeFile(join(bin, "whisper-cli"), whisper, { mode: 0o755 }),
		writeFile(hook, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(root, "forbidden"))}, 'hook\\n');\n`, { mode: 0o755 }),
		symlink(process.execPath, join(bin, "node")),
	]);
	if (media) for (const name of ["ffmpeg", "ffprobe"]) await symlink(await executable(name), join(bin, name));
	const env = {
		HOME: home, PATH: bin, TMPDIR: scratch, LC_ALL: "C", V5_ROOT: root,
		NODE_OPTIONS: `--import=${pathToFileURL(trap).href}`,
		PI_CODING_AGENT_DIR: agent, MICME_MODEL_DIR: cache, MICME_LANGUAGE: "en",
		MICME_TRANSCRIBE_BACKEND: "whisper.cpp", MICME_WHISPER_CPP_BIN: join(bin, "whisper-cli"),
		MICME_AUTO_DOWNLOAD_MODEL: "1", MICME_AUTO_SUBMIT: "1", MICME_HISTORY: "1",
		MICME_OUTPUT_HOOK: hook, MICME_POLISH_PROVIDER: "local-openai", MICME_POLISH_ENDPOINT: "http://localhost:1/v1",
	};
	return { root, agent, models, scratch, project, home, bin, env };
}

async function addWav(root, name, samples = 4000, format) {
	const path = join(root, name);
	await writeFile(path, wave(samples, format));
	return path;
}

async function runImport(f, operation, ...files) {
	return succeeded(await run(process.execPath, [here, "--import-fixture", operation, ...files], { cwd: f.project, env: f.env }), operation);
}

async function holdPartialDecode(f) {
	const ffmpeg = join(f.bin, "ffmpeg");
	const real = await realpath(ffmpeg);
	await rm(ffmpeg);
	await writeFile(ffmpeg, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
if (!args.includes("-i")) process.exit(spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" }).status ?? 1);
const prefix = Buffer.from(${JSON.stringify(wave(4000).subarray(0, 60).toString("hex"))}, "hex");
const output = args.at(-1);
if (output === "-" || output === "fd:" || output.startsWith("pipe:")) await new Promise(resolve => process.stdout.write(prefix, resolve));
else writeFileSync(output, prefix);
const marker = join(process.env.V5_ROOT, "staged-prefix");
writeFileSync(marker, "");
while (existsSync(marker)) await delay(15);
`, { mode: 0o755 });
}

async function noForbidden(f) { await assert.rejects(access(join(f.root, "forbidden")), { code: "ENOENT" }); }

async function originalBytes(files, action) {
	const before = await Promise.all(files.map((file) => readFile(file)));
	await action();
	assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before, "original input bytes");
}

// These are subprocess probes of the public S/E/L surface, not a fake import implementation.
async function importJourney(operation, files) {
	const root = process.env.V5_ROOT;
	const signal = new AbortController().signal;
	if (operation === "rpc") {
		const { default: register } = await import("../src/extension.ts");
		const commands = new Map();
		const messages = [];
		const unexpected = () => assert.fail("import must not paste, submit, send, or open UI in RPC");
		await register({ registerCommand: (name, command) => commands.set(name, command), registerShortcut() {}, on() {}, registerMessageRenderer() {}, sendUserMessage: unexpected, sendMessage: unexpected });
		assert.ok(MICME_TRANSFER_ACTIONS.includes("import"));
		await commands.get("micme").handler("import", { mode: "rpc", hasUI: false, cwd: process.cwd(), isIdle: () => true, ui: { notify: (message) => messages.push(message), getEditorText: () => "keep existing prompt", setEditorText: unexpected, pasteToEditor: unexpected, custom: unexpected } });
		assert.match(messages.join("\n"), /interactive|TUI/i);
		return;
	}
	const { importFiles, cancelJob } = await import("../src/transfer/import.ts");
	assert.equal(typeof importFiles, "function", "L importFiles entry is not built yet");
	const { page, verifiedAudio, enqueueImport, retry, deleteRow } = await import("../src/transfer/library.ts");
	const { previewPrune, applyPrune } = await import("../src/transfer/retention.ts");
	const { listInstalled } = await import("../src/transfer/recognition.ts");
	const { setForeground } = await import("../src/transfer/jobs.ts");
	const installed = await listInstalled();
	const choice = (name) => {
		const match = installed.find(({ variantId }) => modelNamed(variantId, name));
		assert.ok(match, `Expected installed fixture model ${name}; got ${JSON.stringify(installed)}`);
		return match;
	};
	const first = choice("tiny.en");
	const second = choice("base.en");
	const row = async (id) => (await page(null)).find((entry) => entry.id === id);
	const settled = (id) => until(async () => {
		const value = await row(id);
		return value && !["queued", "decoding", "recognizing"].includes(value.state) ? value : null;
	}, `terminal import state for ${id}`);
	const release = ({ pid }) => writeFile(join(root, `release-${pid}`), "");

	if (operation === "disabled") {
		const ids = await importFiles(files, first, signal).catch((error) => {
			assert.match(String(error), /history|library/i);
			return [];
		});
		assert.deepEqual(ids, [], "history must be explicitly enabled before import");
	} else if (operation === "partial") {
		const [id] = await importFiles(files, first, signal);
		const marker = join(root, "staged-prefix");
		await until(() => access(marker).then(() => true, () => false), "decoder wrote a truncated WAV and is holding the output open");
		try {
			assert.equal((await row(id)).wav, null);
			assert.equal(await verifiedAudio(id, signal), null);
			cancelJob(id);
			const canceled = await settled(id);
			assert.equal(canceled.state, "canceled");
			assert.equal(canceled.wav, null); assert.equal(canceled.raw, null);
			assert.deepEqual(await log(root), [], "partial audio never reaches inference");
		} finally { await rm(marker, { force: true }); }
	} else if (operation === "mixed") {
		const ids = await importFiles(files, first, signal);
		assert.equal(ids.length, files.length, "bad inputs must have individual outcomes");
		const rows = await Promise.all(ids.map(settled));
		assert.deepEqual(rows.map((value) => value.filename).sort(), files.map((file) => basename(file)).sort());
		assert.ok(rows.every((value) => value.source === "import" && value.polished === null));
		for (const [index, file] of files.entries()) {
			const value = rows.find((entry) => entry.filename === basename(file));
			const audio = await verifiedAudio(value.id, signal);
			if (index >= 2) {
				assert.match(value.state, /failed$/);
				assert.equal(value.raw, null); assert.equal(value.wav, null); assert.equal(audio, null);
				continue;
			}
			assert.equal(value.state, "ready"); assert.equal(value.raw, fixtureText); assert.equal(value.modelId, first.variantId);
			assert.equal(value.totalSamples, 4000, "first audio track, not longer second track");
			assert.equal(value.doneSamples, value.totalSamples);
			assert.ok(audio && audio.bytes > 8000);
			assert.deepEqual(value.wav, { bytes: audio.bytes, sha256: audio.sha256 });
			const { createLiveRecordingDirectory } = await import("../src/recording-dir.ts");
			const target = await createLiveRecordingDirectory(process.cwd(), false);
			try {
				const fd = target.openFile(await audio.copyTo(target, signal), constants.O_RDONLY);
				try {
					const bytes = readFileSync(fd);
					assert.equal(digest(bytes), audio.sha256);
					assert.deepEqual(pcmFormat(bytes), [1, 1, 16000, 16]);
				} finally { closeSync(fd); }
			} finally { await target.remove(); target.close(); }
		}
		assert.equal((await log(root)).length, 2, "only two valid audio streams reach inference");
		await applyPrune(await previewPrune("count:0"), signal);
		assert.deepEqual((await page(null)).map(({ id }) => id).sort(), ids.toSorted());
		await deleteRow(rows[0].id, signal);
		assert.equal(await row(rows[0].id), undefined); assert.equal(await verifiedAudio(rows[0].id, signal), null);
	} else if (operation === "queue") {
		const [saved] = await importFiles([files[0]], first, signal);
		assert.equal((await settled(saved)).state, "ready");
		await writeFile(join(root, "hold"), "");
		const previous = (await log(root)).length;
		const [long] = await importFiles([files[1]], first, signal);
		const running = await until(async () => (await log(root))[previous], "first long-import chunk");
		assert.ok(running.bytes < 65 * 16000 * 2, "imports must not send the whole long file to one ASR call");
		setForeground(true);
		let retrying;
		try {
			process.env.MICME_DEFAULT_WHISPER_CPP_MODEL = "base.en";
			retrying = retry(saved, second, signal);
			void retrying.catch(() => {}); // Observe rejection at the join, not as an unhandled promise.
			const [queued, canceled] = await importFiles(files.slice(2), first, signal);
			cancelJob(canceled);
			assert.equal((await settled(canceled)).state, "canceled");
			await release(running);
			await until(async () => (await row(long)).doneSamples > 0, "completed chunk while foreground was active");
			assert.equal((await log(root)).length, previous + 1, "no background inference while foreground owns the lane");
			setForeground(false);
			const retried = await until(async () => (await log(root))[previous + 1], "retry has first use of the released lane");
			assert.equal(retried.model, "ggml-base.en.bin");
			await rm(join(root, "hold"));
			await retrying;
			assert.equal((await settled(saved)).modelId, second.variantId);
			assert.equal((await settled(long)).modelId, first.variantId);
			assert.equal((await settled(queued)).state, "ready");
			const resumed = (await log(root)).slice(previous + 2);
			assert.ok(resumed.length >= 2, "long job resumed and queued import ran");
			assert.ok(resumed.every(({ model }) => model === "ggml-tiny.en.bin"), "queued jobs retain their fixed model");
		} finally { setForeground(false); await rm(join(root, "hold"), { force: true }); await retrying; }
	} else if (operation === "crash") {
		const incomplete = await enqueueImport(basename(files[0]), first, signal);
		await writeFile(join(root, "hold"), "");
		const [complete] = await importFiles([files[1]], first, signal);
		await until(async () => (await log(root))[0], "ASR started after complete decode");
		assert.equal(await verifiedAudio(incomplete, signal), null, "uncompleted inputs must not publish audio");
		assert.ok(await verifiedAudio(complete, signal));
		await writeFile(join(root, "ids.json"), JSON.stringify({ incomplete, complete }));
		process.exit(0); // Intentional unclean owner exit, not normal cancellation.
	} else {
		assert.equal(operation, "recover");
		const { incomplete, complete } = JSON.parse(await readFile(join(root, "ids.json"), "utf8"));
		assert.equal((await row(incomplete)).state, "interrupted");
		assert.equal((await row(complete)).state, "interrupted");
		assert.equal(await verifiedAudio(incomplete, signal), null);
		assert.ok(await verifiedAudio(complete, signal));
		const previous = (await log(root)).length;
		await retry(incomplete, second, signal).catch((error) => assert.match(String(error), /reselect|verified|audio|source/i));
		assert.match((await row(incomplete)).state, /^(?:interrupted|asr-failed)$/);
		assert.equal((await log(root)).length, previous, "retry cannot infer without verified audio or a reselected source");
		await retry(complete, second, signal);
		const recovered = await until(async () => {
			const value = await row(complete);
			return value?.state === "ready" && value;
		}, "verified restart retry becomes ready");
		assert.equal(recovered.modelId, second.variantId);
		await deleteRow(complete, signal);
		assert.equal(await row(complete), undefined); assert.equal(await verifiedAudio(complete, signal), null);
	}
}

async function installCli(f) {
	const npm = process.env.npm_execpath;
	const invoke = (args, cwd) => run(npm ? process.execPath : "npm", npm ? [npm, ...args] : args, { cwd });
	const [{ filename }] = JSON.parse(succeeded(await invoke(["pack", "--offline", "--json", "--pack-destination", f.root], repo), "npm pack"));
	succeeded(await invoke(["install", "--offline", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund", join(f.root, filename)], f.project), "peer-free installation");
	const modules = join(f.project, "node_modules");
	await assert.rejects(access(join(modules, "@earendil-works", "pi-coding-agent")), { code: "ENOENT" });
	await assert.rejects(access(join(modules, "@earendil-works", "pi-tui")), { code: "ENOENT" });
	const cli = join(modules, ".bin", "micme-transcribe");
	assert.ok(await access(cli).then(() => true, () => false), "K micme-transcribe bin is not in the installed package yet");
	assert.ok((await realpath(cli)).startsWith(modules + sep), "must invoke the installed tarball, not the checkout");
	return (args, extra = {}) => run(cli, args, { cwd: f.project, env: { ...f.env, V5_INSTALLED: "1", ...extra, NODE_OPTIONS: f.env.NODE_OPTIONS + " --no-experimental-strip-types" } });
}

async function checkCli(f, cli, audio) {
	const list = JSON.parse(succeeded(await cli([K.listModels, K.json]), "installed model list"));
	assert.ok(list.models.length > 0 && list.models.every((id) => typeof id === "string"));
	assert.equal(new Set(list.models).size, list.models.length);
	const modelLines = succeeded(await cli([K.listModels]), "model text listing").trim().split(/\r?\n/);
	assert.equal(modelLines.length, list.models.length);
	assert.ok(list.models.every((id) => modelLines.some((line) => line.includes(id))));
	const model = list.models.find((id) => modelNamed(id, "tiny.en"));
	assert.ok(model, `missing fixture model in ${JSON.stringify(list)}`);
	const args = [K.model, model, K.device, "auto"];
	assert.equal(succeeded(await cli([...args, audio]), "plain transcript").trimEnd(), fixtureText);
	const before = (await log(f.root)).length;
	const result = JSON.parse(succeeded(await cli([...args, K.repeat, "3", K.json, audio]), "repeat JSON"));
	assert.deepEqual(Object.keys(result).sort(), ["audioSamples", "boundDevice", "device", "language", "model", "requestedDevice", "runs", "text"]);
	assert.equal(result.model, model); assert.equal(result.requestedDevice, "auto");
	assert.equal(result.text, fixtureText); assert.equal(result.audioSamples, 4000);
	assert.equal(result.runs.length, 3);
	for (const [i, item] of result.runs.entries()) {
		assert.equal(item.index, result.runs[0].index + i);
		assert.ok(Number.isInteger(item.index) && Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0);
	}
	const calls = await log(f.root);
	assert.equal(calls.length, before + 3, "--repeat must really infer three times");
	assert.ok(calls.slice(before).every(({ model, bytes }) => model === "ggml-tiny.en.bin" && bytes === calls[before].bytes));
	const stopped = calls.length;
	const invalid = await Promise.all([
		addWav(f.root, "stereo.wav", 4000, { channels: 2 }), addWav(f.root, "rate.wav", 4000, { rate: 8000 }),
		addWav(f.root, "float.wav", 4000, { bits: 32, format: 3 }), addWav(f.root, "pcm24.wav", 4000, { bits: 24 }),
	]);
	const truncated = join(f.root, "truncated.wav");
	await writeFile(truncated, wave(4000).subarray(0, 47));
	for (const [argv, expected] of [
		[[], status.usage], [["--unknown"], status.usage], [[K.listModels, K.listDevices], status.usage], [[...args, K.repeat, "0", audio], status.usage],
		[[...args, K.repeat, "-1", audio], status.usage], [[...args, K.repeat, "1.5", audio], status.usage],
		[[...args, K.repeat, "", audio], status.usage], [[...args, K.repeat, "9".repeat(10001), audio], status.usage],
		[[...args, join(f.root, "missing.wav")], status.usage], [[...args, f.root], status.usage],
		...invalid.concat(truncated).map((file) => [[...args, K.json, file], status.usage]),
		[[K.model, "absent-模型", K.device, "auto", audio], status.failed],
		[[K.model, model, K.device, "fixture-unlisted", audio], status.failed],
	]) {
		const label = argv.map((value) => value.slice(0, 120)).join(" ");
		const result = await cli(argv);
		assert.equal(result.status, expected, `${label}: ${result.stderr}`);
		assert.equal(result.stdout, "", label); assert.ok(result.stderr.trim(), label);
		assert.doesNotMatch(result.stderr, /\n\s+at\s|ERR_MODULE_NOT_FOUND|V5 forbidden effect/, label);
	}
	assert.equal((await log(f.root)).length, stopped, "invalid inputs and missing selections must not reach inference");
	return model;
}

async function checkDevices(f, cli, model, audio) {
	const deviceCli = (args, observed, backend) => cli(args, { V5_DEVICES: "1", V5_OBSERVED: observed, V5_ACTUAL_COMPUTE: backend });
	const listed = JSON.parse(succeeded(await deviceCli([K.listDevices, K.json]), "device JSON listing"));
	assert.deepEqual(listed.devices.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), devices.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
	const lines = succeeded(await deviceCli([K.listDevices]), "device text listing").trim().split(/\r?\n/);
	assert.equal(lines.length, devices.length);
	for (const { id, label } of [firstDevice, secondDevice]) assert.ok(lines.some((line) => line.includes("vulkan") && line.includes(id) && line.includes(label)), lines.join("\n"));
	const offset = (await log(f.root)).length;
	for (const [request, seen, backend] of [[secondDevice.id, secondDevice, "vulkan"], ["auto", firstDevice, "vulkan"], ["vulkan", null, "vulkan"], ["auto", null, "unknown"]]) {
		const result = JSON.parse(succeeded(await deviceCli([K.model, model, K.device, request, K.json, audio], seen?.id, backend), `device ${request} reporting ${backend}`));
		assert.deepEqual([result.requestedDevice, result.device, result.boundDevice, result.language], [request, backend, seen, "en"]);
	}
	const calls = (await log(f.root)).slice(offset);
	assert.deepEqual(calls.map(({ choice }) => choice.requestedDeviceId), [secondDevice.id, null, null, null]);
	assert.ok(calls.every(({ job, sha256 }) => job === "cli" && sha256 === digest(wave(4000))));
}

if (process.argv[2] === "--import-fixture") {
	await importJourney(process.argv[3], process.argv.slice(4));
} else {
	test("V5 S: /micme import refuses RPC without opening history or changing the prompt", unix, async (t) => {
		const f = await fixture(t);
		await runImport(f, "rpc");
		assert.deepEqual(await readdir(f.agent), []);
		await noForbidden(f);
	});

	test("V5 L: mixed local files import the first audio track and isolate invalid files", unix, async (t) => {
		const f = await fixture(t, { media: true });
		const pcm = await addWav(f.root, "plain 日本.wav");
		const otherTrack = await addWav(f.root, "second.wav", 16000, { marker: 9000 });
		const mixed = join(f.root, "two tracks.mkv");
		const noAudio = join(f.root, "video-only.mkv");
		const corrupt = join(f.root, "corrupt.wav");
		const ffmpeg = (args, output) => run(join(f.bin, "ffmpeg"), ["-hide_banner", "-loglevel", "error", ...args, output]);
		const video = ["-f", "lavfi", "-i", "color=s=16x16:r=4:d=1"];
		succeeded(await ffmpeg([...video, "-i", pcm, "-i", otherTrack, "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "ffv1", "-c:a", "libopus"], mixed), "create mixed media fixture");
		succeeded(await ffmpeg([...video, "-c:v", "ffv1"], noAudio), "create no-audio fixture");
		await writeFile(corrupt, "not audio, despite the suffix\n");
		let requests = 0;
		const contact = createServer((_req, res) => { requests++; res.writeHead(404).end(); });
		contact.listen(0, "127.0.0.1");
		await once(contact, "listening");
		t.after(() => new Promise((resolve) => contact.close(resolve)));
		const playlist = join(f.root, "external.ffconcat");
		await writeFile(playlist, `ffconcat version 1.0\nfile 'http://127.0.0.1:${contact.address().port}/audio.wav'\n`);
		const sources = [pcm, mixed, corrupt, noAudio, playlist];
		await originalBytes(sources, () => runImport(f, "mixed", ...sources));
		assert.equal(requests, 0, "a local playlist must not cause an external media read");
		await noForbidden(f);
	});

	test("V5 L: disabled history queues nothing; cancel during decode never publishes partial audio", unix, async (t) => {
		const f = await fixture(t, { media: true });
		const file = await addWav(f.root, "interrupted.wav");
		await originalBytes([file], async () => {
			await runImport({ ...f, env: { ...f.env, MICME_HISTORY: "0" } }, "disabled", file);
			assert.deepEqual(await readdir(f.agent), [], "opt-out must not open or create a library");
			assert.deepEqual(await log(f.root), []);
			await holdPartialDecode(f);
			await runImport(f, "partial", file);
		});
		await noForbidden(f);
	});

	test("V5 E/L: foreground yields at a chunk boundary, retry wins, and queued models stay fixed", unix, async (t) => {
		const f = await fixture(t, { media: true });
		const files = await Promise.all([addWav(f.root, "retry.wav"), addWav(f.root, "long.wav", 65 * 16000), addWav(f.root, "queued.wav"), addWav(f.root, "canceled.wav")]);
		await originalBytes(files, () => runImport(f, "queue", ...files));
		await noForbidden(f);
	});

	test("V5 L: restart distinguishes interrupted verified audio from a source needing reselection", unix, async (t) => {
		const f = await fixture(t, { media: true });
		const files = await Promise.all([addWav(f.root, "pending.wav"), addWav(f.root, "decoded.wav")]);
		await originalBytes(files, () => runImport(f, "crash", ...files));
		await rm(join(f.root, "hold"));
		await rm(files[1]); // The retry must not reopen the source path after restart.
		await runImport(f, "recover");
		await noForbidden(f);
	});

	test("V5 K: the installed peer-free CLI validates WAV, repeats offline, and reports observed device identity", unix, async (t) => {
		const f = await fixture(t);
		const audio = await addWav(f.root, "input 日本.wav");
		const cli = await installCli(f);
		const project = await readdir(f.project);
		await originalBytes([audio], async () => {
			const model = await checkCli(f, cli, audio);
			await checkDevices(f, cli, model, audio);
		});
		await noForbidden(f);
		assert.deepEqual(await readdir(f.agent), [], "no library or Pi profile");
		assert.deepEqual(await readdir(f.home), [], "no home cache or login state");
		assert.deepEqual((await readdir(f.project)).sort(), project.sort(), "no stray transcripts or history in cwd");
		assert.deepEqual((await readdir(f.models)).sort(), ["ggml-base.en.bin", "ggml-tiny.en.bin"], "no model downloads");
		assert.deepEqual(await readdir(f.scratch), [], "no retained audio or transcript artifacts");
	});
}
