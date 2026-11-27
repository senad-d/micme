import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
export const fixtureText = "fixture transcript";
export const firstDevice = { id: "fixture-vulkan:1", label: "Fixture One" };
export const secondDevice = { id: "fixture-vulkan:2", label: "Fixture Two" };
export const devices = [{ backend: "vulkan", device: firstDevice }, { backend: "vulkan", device: secondDevice }, { backend: "cpu", device: null }];

export async function run(file, args, options) {
	const child = spawn(file, args, { signal: AbortSignal.timeout(60_000), stdio: ["ignore", "pipe", "pipe"], ...options });
	let stdout = "", stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const [status, signal] = await once(child, "close");
	assert.equal(signal, null, `${file} terminated by ${signal}\n${stderr}`);
	return { status, stdout, stderr };
}

export function succeeded(result, context) {
	assert.equal(result.status, 0, `${context}\n${result.stderr}\n${result.stdout}`);
	return result.stdout;
}

export function wave(samples, { rate = 16000, channels = 1, bits = 16, format = 1, marker = 7000 } = {}) {
	const align = channels * bits / 8;
	const bytes = Buffer.alloc(44 + samples * align);
	bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(format, 20); bytes.writeUInt16LE(channels, 22);
	bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * align, 28); bytes.writeUInt16LE(align, 32);
	bytes.writeUInt16LE(bits, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * align, 40);
	if (bits === 16) for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(marker * (i % 16 < 8 ? 1 : -1), i);
	return bytes;
}

export async function log(root) {
	const text = await readFile(join(root, "calls"), "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
		return "";
	});
	return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function until(get, description) {
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
  appendFileSync(join(root, "forbidden"), kind + " from " + process.argv[1] + "\\n");
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
if (process.env.V5_INFERENCE_ERROR) { process.stderr.write("V5 decoder-only diagnostic\\n"); process.exit(1); }
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
		if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate);
	}
	assert.fail(`V5 fixtures require ${name} on PATH`);
}

async function mediaExecutable(name) {
	const file = await executable(name);
	const protocols = succeeded(await run(file, ["-hide_banner", "-protocols"]), `${name} protocol inventory`);
	assert.match(protocols, /^\s+fd$/m, `V5 import requires ${name} built with seekable fd: support`);
	return file;
}

export async function fixture(t, { media = false } = {}) {
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
	if (media) {
		for (const name of ["ffmpeg", "ffprobe"]) await symlink(await mediaExecutable(name), join(bin, name));
	}
	const env = {
		HOME: home, PATH: bin, TMPDIR: scratch, LC_ALL: "C", V5_ROOT: root,
		NODE_OPTIONS: `--import=${pathToFileURL(trap).href}`, NODE_DISABLE_COMPILE_CACHE: "1",
		PI_CODING_AGENT_DIR: agent, MICME_MODEL_DIR: cache, MICME_LANGUAGE: "en",
		MICME_TRANSCRIBE_BACKEND: "whisper.cpp", MICME_WHISPER_CPP_BIN: join(bin, "whisper-cli"),
		MICME_AUTO_DOWNLOAD_MODEL: "1", MICME_AUTO_SUBMIT: "1", MICME_HISTORY: "1",
		MICME_OUTPUT_HOOK: hook, MICME_POLISH_PROVIDER: "local-openai", MICME_POLISH_ENDPOINT: "http://localhost:1/v1",
	};
	return { root, agent, models, scratch, project, home, cache, bin, env };
}

export async function addWav(root, name, samples = 4000, format) {
	const path = join(root, name);
	await writeFile(path, wave(samples, format));
	return path;
}

export async function holdPartialDecode(f) {
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

export async function noForbidden(f) {
	const attempts = await readFile(join(f.root, "forbidden"), "utf8").catch((error) => {
		if (error.code !== "ENOENT") throw error;
		return "";
	});
	assert.equal(attempts, "", "unexpected network, UI, or hook effects");
}

export async function originalBytes(files, action) {
	const before = await Promise.all(files.map((file) => readFile(file)));
	await action();
	assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before, "original input bytes");
}

async function writeOfflineConsumer(f, pack) {
	const lock = JSON.parse(await readFile(join(repo, "package-lock.json"), "utf8"));
	const { name, version, license, dependencies, bin, engines, peerDependencies, peerDependenciesMeta } = lock.packages[""];
	const micme = await pack(repo);
	const consumer = { name: "micme-offline-smoke", version: "1.0.0", dependencies: { [name]: micme.resolved } };
	const packages = {
		"": consumer,
		[`node_modules/${name}`]: { version, license, ...micme, dependencies, bin, engines, peerDependencies, peerDependenciesMeta },
	};
	// Repack only runtime dependencies from this checkout's locked npm ci tree.
	// Keep metadata for other platforms' optional packages; ci won't fetch them.
	for (const [path, record] of Object.entries(lock.packages)) {
		if (!path || record.dev || record.peer) continue;
		const installed = join(repo, path);
		const manifest = await readFile(join(installed, "package.json"), "utf8").catch((error) => {
			if (error.code !== "ENOENT") throw error;
			return null;
		});
		if (!manifest) {
			assert.ok(record.optional && (record.os && !record.os.includes(process.platform) || record.cpu && !record.cpu.includes(process.arch)), `Run npm ci with runtime dependencies: ${path} is missing`);
			packages[path] = record;
			continue;
		}
		assert.equal(JSON.parse(manifest).version, record.version, `installed version for ${path}`);
		packages[path] = { ...record, ...await pack(installed, "--ignore-scripts") };
	}
	await writeFile(join(f.project, "package.json"), JSON.stringify(consumer));
	await writeFile(join(f.project, "package-lock.json"), JSON.stringify({ ...consumer, lockfileVersion: 3, packages }));
}

export async function installCli(f) {
	const npm = process.env.npm_execpath ?? await executable("npm");
	const store = join(f.root, "tarballs");
	await mkdir(store);
	const invoke = (args, cwd, cache) => run(process.execPath, [npm, ...args], {
		cwd,
		env: {
			...f.env, PATH: [f.bin, process.env.PATH].join(delimiter),
			npm_config_cache: cache, npm_config_offline: "true", npm_config_update_notifier: "false",
			npm_config_audit: "false", npm_config_fund: "false",
		},
	});
	await writeOfflineConsumer(f, async (path, ...flags) => {
		const [{ filename, integrity }] = JSON.parse(succeeded(await invoke(["pack", "--json", "--pack-destination", store, ...flags, path], repo, join(f.root, "pack-cache")), `npm pack ${path}`));
		return { resolved: `file:../tarballs/${filename}`, integrity };
	});
	// Separate cache: consumer installation cannot reuse artifacts cached by pack.
	succeeded(await invoke(["ci", "--ignore-scripts", "--omit=peer"], f.project, join(f.root, "empty-install-cache")), "peer-free installation from local tarballs");
	const modules = join(f.project, "node_modules");
	for (const scope of ["@earendil-works", "@oh-my-pi", "@mariozechner"]) {
		await assert.rejects(access(join(modules, scope)), { code: "ENOENT" });
	}
	const cli = join(modules, ".bin", "micme-transcribe");
	assert.ok(await access(cli).then(() => true, () => false), "K micme-transcribe bin is not in the installed package yet");
	assert.ok((await realpath(cli)).startsWith(modules + sep), "must invoke the installed tarball, not the checkout");
	return (args, extra = {}) => run(cli, args, { cwd: f.project, env: { ...f.env, V5_INSTALLED: "1", ...extra, NODE_OPTIONS: f.env.NODE_OPTIONS + " --no-experimental-strip-types" } });
}
