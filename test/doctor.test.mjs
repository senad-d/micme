import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = dirname(packagePath);
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const runtimeProbe = `
import { resolveTranscriptionPlan } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/backends.ts")).href)};
import { getTranscriptionMode, reloadMicmeConfig } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/config.ts")).href)};
import { resolveLivePlan } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/live-plan.ts")).href)};
import { resolveWhisperCppModel } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/models.ts")).href)};
import { buildLiveWorkerCommand } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/streaming.ts")).href)};
reloadMicmeConfig();
const mode = getTranscriptionMode();
const model = resolveWhisperCppModel({ preserveExplicitPath: mode === "stream" });
const plan = resolveTranscriptionPlan({ transcriptionMode: mode });
let worker, liveError;
if (mode === "stream") {
	try { worker = buildLiveWorkerCommand(resolveLivePlan()); }
	catch (error) { liveError = error.message; }
}
console.log(JSON.stringify({ model, plan, worker, liveError }));
`;
// Fail even if a caller catches download errors; doctor must never try to fetch weights.
const noDownload = `data:text/javascript,${encodeURIComponent("globalThis.fetch = () => { console.error('doctor attempted a download'); process.exit(86); };")}`;

function isolatedEnvironment(root, binDir) {
	const environment = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("MICME_") || key === "PI_CODING_AGENT_DIR" || value === undefined) continue;
		environment[key] = value;
	}
	return { ...environment, HOME: root, PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT;.COM", PI_CODING_AGENT_DIR: root };
}

function runNode(args, environment) {
	const result = spawnSync(process.execPath, args, {
		cwd: packageRoot,
		encoding: "utf8",
		env: environment,
		maxBuffer: 1024 * 1024,
		timeout: 60_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

async function buildDoctorFixture(root) {
	await writeFile(join(root, "package.json"), JSON.stringify({ type: packageJson.type }));
	runNode([
		join(packageRoot, "node_modules", "typescript", "bin", "tsc"),
		"--project", "scripts/tsconfig.doctor.json",
		"--outDir", join(root, "dist", "doctor"),
	], process.env);
	return join(root, packageJson.bin["micme-doctor"]);
}

function getDoctorField(output, label) {
	const prefix = `- ${label}: `;
	const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
	assert.ok(line, `missing doctor field ${label} in:\n${output}`);
	return line.slice(prefix.length);
}

async function createWhisperCppFixture(binDir) {
	await mkdir(binDir, { recursive: true });
	const executable = join(binDir, process.platform === "win32" ? "whisper-cli.EXE" : "whisper-cli");
	// The doctor only discovers this file; it never starts it.
	await writeFile(executable, process.platform === "win32" ? "" : "#!/bin/sh\nexit 0\n");
	if (process.platform !== "win32") await chmod(executable, 0o755);
}

function runRuntimeProbe(environment) {
	return JSON.parse(runNode(["--import", noDownload, "--input-type=module", "--eval", runtimeProbe], environment));
}

async function createLoggedCommand(binary, protocolVersion) {
	const command = protocolVersion === undefined
		? "exit 99"
		: `[ "$#" -eq 1 ] && [ "$1" = --protocol-version ] || exit 99\nprintf '${protocolVersion}\\n'`;
	await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$@" >> "$0.args"\n${command}\n`, { mode: 0o755 });
}

function buildModelFixtures(modelDir) {
	return [
		{ id: "default", values: {} },
		{ id: "configured-name", values: { MICME_DEFAULT_WHISPER_CPP_MODEL: "medium.en" } },
		{ id: "explicit-en-off", values: { MICME_WHISPER_CPP_MODEL: join(modelDir, "ggml-base.en.bin") } },
		{ id: "explicit-en-on", values: { MICME_WHISPER_CPP_MODEL: join(modelDir, "ggml-base.en.bin"), MICME_TRANSLATE_TO_ENGLISH: "bs" } },
		{ id: "explicit-turbo-off", values: { MICME_WHISPER_CPP_MODEL: join(modelDir, "ggml-large-v3-turbo.bin") } },
		{
			id: "explicit-turbo-on-missing-fallback",
			values: { MICME_WHISPER_CPP_MODEL: join(modelDir, "ggml-large-v3-turbo.bin"), MICME_TRANSLATE_TO_ENGLISH: "hr" },
			configuredModelFile: join(modelDir, "ggml-large-v3-turbo.bin"),
		},
		{ id: "missing-explicit", values: { MICME_WHISPER_CPP_MODEL: join(modelDir, "ggml-missing.gguf") } },
	];
}

test("doctor reports only supported placeholders from configured hooks", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-hook-redaction-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const secret = "{DummyBracedSecret}";
	await writeFile(join(root, "micme.json"), JSON.stringify({
		MICME_MODEL_DIR: root,
		MICME_RECORD_COMMAND: `printf ${secret} {audio} {audioRaw} {tempDir} {tempDirRaw}`,
		MICME_TRANSCRIBE_COMMAND: `printf ${secret} {transcript} {transcriptRaw}`,
	}));

	const doctor = runNode(["scripts/doctor.mjs"], isolatedEnvironment(root, join(root, "bin")));

	assert.equal(doctor.includes(secret), false, "doctor exposed an unsupported brace-wrapped value");
	assert.match(doctor, /custom record command: configured \(\d+ chars; placeholders: \{audio\}, \{audioRaw\}, \{tempDir\}, \{tempDirRaw\}; full value redacted\)/);
	assert.match(doctor, /custom transcribe command: configured \(\d+ chars; placeholders: \{transcript\}, \{transcriptRaw\}; full value redacted\)/);
});

test("JavaScript doctor starts without type stripping and matches the runtime model and backend contract", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const doctorPath = await buildDoctorFixture(root);
	const binDir = join(root, "bin");
	const modelDir = join(root, "models");
	await createWhisperCppFixture(binDir);
	await mkdir(modelDir, { recursive: true });

	for (const fixture of buildModelFixtures(modelDir)) {
		await rm(modelDir, { recursive: true, force: true });
		await mkdir(modelDir, { recursive: true });
		if (fixture.configuredModelFile) await writeFile(fixture.configuredModelFile, "configured model");
		const secret = `DOCTOR-SECRET-${fixture.id}`;
		const config = {
			MICME_AUTO_DOWNLOAD_MODEL: "1",
			MICME_MODEL_DIR: modelDir,
			MICME_TRANSCRIBE_BACKEND: "whisper.cpp",
			MICME_TRANSCRIBE_COMMAND: `printf ${secret} {audioRaw}`,
			MICME_TRANSLATE_TO_ENGLISH: "off",
			...fixture.values,
		};
		await writeFile(join(root, "micme.json"), `${JSON.stringify(config, null, 2)}\n`);
		const environment = isolatedEnvironment(root, binDir);
		const runtime = runRuntimeProbe(environment);
		const doctor = runNode(["--no-experimental-strip-types", doctorPath], environment);

		assert.match(doctor, /^Micme doctor\r?$/m, fixture.id);
		assert.equal(runtime.plan.effectiveBackend, "whisper.cpp", fixture.id);
		assert.equal(getDoctorField(doctor, "effective model path"), runtime.plan.modelPath, fixture.id);
		assert.equal(getDoctorField(doctor, "effective model name"), runtime.plan.modelName, fixture.id);
		assert.equal(getDoctorField(doctor, "effective model source"), runtime.plan.modelSource, fixture.id);
		assert.equal(doctor.includes(secret), false, fixture.id);
		assert.match(doctor, /full value redacted/, fixture.id);
		assert.match(doctor, /placeholders: \{audioRaw\}/, fixture.id);

		if (fixture.id === "explicit-turbo-on-missing-fallback") {
			assert.equal(runtime.model.exists, false);
			assert.equal(runtime.plan.modelPath, join(modelDir, "ggml-large-v3.bin"));
			assert.ok(doctor.includes(`! resolved whisper.cpp model is missing: ${runtime.plan.modelPath}`));
			assert.doesNotMatch(doctor, /- effective model path: .*large-v3-turbo/);
		}
	}
});

test("stream doctor and runtime agree on worker and weights, but doctor only probes Worker v1", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-live-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const doctorPath = await buildDoctorFixture(root);
	const binDir = join(root, "bin");
	const modelDir = join(root, "models");
	const worker = join(binDir, "micme-live");
	const legacy = join(binDir, "whisper-stream");
	const clip = join(binDir, "whisper-cli");
	const recorder = join(binDir, "record-hook");
	const modelPath = join(modelDir, "ggml-small.bin");
	const vadPath = join(modelDir, "cached VAD.bin");
	await mkdir(binDir);
	await mkdir(modelDir);
	await createLoggedCommand(worker, 1);
	for (const binary of [legacy, clip, recorder]) await createLoggedCommand(binary);
	await writeFile(modelPath, "cached ASR fixture");
	await writeFile(vadPath, "cached VAD fixture");
	await writeFile(join(root, "micme.json"), JSON.stringify({
		MICME_TRANSCRIPTION_MODE: "stream",
		MICME_MODEL_DIR: modelDir,
		MICME_WHISPER_CPP_MODEL: "$MICME_MODEL_DIR/ggml-small.bin",
		MICME_VAD_MODEL: "$MICME_MODEL_DIR/ignored VAD.bin",
		MICME_LANGUAGE: "en",
		MICME_RECORD_COMMAND: "record-hook {audioRaw}",
		MICME_WHISPER_STREAM_BIN: legacy,
		MICME_STREAM_CAPTURE: "7",
		MICME_STREAM_FINALIZE_WITH_CLIP: true,
		MICME_AUTO_DOWNLOAD_MODEL: false,
	}));
	const environment = { ...isolatedEnvironment(root, binDir), MICME_LANGUAGE: " DE ", MICME_VAD_MODEL: vadPath };
	const runtime = runRuntimeProbe(environment);
	const doctor = runNode(["--no-experimental-strip-types", "--import", noDownload, doctorPath], environment);

	assert.equal(runtime.plan.effectiveBackend, "whisper.cpp");
	assert.equal(runtime.plan.binary, worker);
	assert.equal(runtime.plan.modelPath, modelPath);
	assert.equal(runtime.plan.live.vadModelPath, vadPath);
	assert.equal(runtime.plan.live.language, "de");
	assert.equal(runtime.plan.live.finalizeWithClip, true);
	assert.equal(runtime.worker.command, worker);
	assert.deepEqual(runtime.worker.args, ["--model", modelPath, "--vad-model", vadPath, "--language", "de"]);
	assert.equal(getDoctorField(doctor, "transcription mode"), "stream");
	assert.equal(getDoctorField(doctor, "live worker binary"), runtime.plan.binary);
	assert.equal(getDoctorField(doctor, "effective model path"), runtime.plan.modelPath);
	assert.equal(getDoctorField(doctor, "live VAD model path"), runtime.plan.live.vadModelPath);
	assert.equal(getDoctorField(doctor, "live language"), runtime.plan.live.language);
	assert.equal(getDoctorField(doctor, "live final clip refinement"), "on");
	assert.match(getDoctorField(doctor, "ignored legacy stream settings"), /MICME_WHISPER_STREAM_BIN.*MICME_STREAM_CAPTURE.*micme-live.*Audio input/);
	assert.match(doctor, /^✓ live worker protocol: Worker v1 available; model readiness and capture not tested\r?$/m);
	assert.doesNotMatch(doctor, /model is missing|VAD weights not present/);
	assert.equal(await readFile(`${worker}.args`, "utf8"), "--protocol-version\n");
	for (const binary of [legacy, clip, recorder]) await assert.rejects(access(`${binary}.args`), { code: "ENOENT" });
});

test("stream doctor reports the installed runtime default instead of the clip model", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-live-default-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const modelDir = join(root, "models");
	const modelPath = join(modelDir, "ggml-base.en.bin");
	await mkdir(modelDir);
	await writeFile(modelPath, "cached ASR fixture");
	await createLoggedCommand(join(root, "micme-live"), 1);
	const environment = { ...isolatedEnvironment(root, root), MICME_TRANSCRIPTION_MODE: "stream", MICME_MODEL_DIR: modelDir };
	const runtime = runRuntimeProbe(environment);
	const doctor = runNode(["--import", noDownload, "scripts/doctor.mjs"], environment);

	assert.equal(getDoctorField(doctor, "effective model path"), modelPath);
	assert.equal(getDoctorField(doctor, "effective model name"), "base.en");
	assert.equal(getDoctorField(doctor, "effective model source"), "default-name");
	assert.equal(runtime.plan.modelPath, modelPath);
	assert.equal(runtime.plan.modelName, "base.en");
	assert.equal(runtime.worker.args[runtime.worker.args.indexOf("--model") + 1], modelPath);
	assert.ok(doctor.split(/\r?\n/).includes(`✓ resolved whisper.cpp model: ${modelPath}`), doctor);
	assert.doesNotMatch(doctor, /^! resolved whisper\.cpp model is missing:/m);
});

test("stream doctor and runtime reject SDL-only installs without launching whisper-stream", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-sdl-only-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const legacy = join(root, "whisper-stream");
	await createLoggedCommand(legacy);
	await writeFile(join(root, "micme.json"), JSON.stringify({
		MICME_TRANSCRIPTION_MODE: "stream",
		MICME_MODEL_DIR: join(root, "models"),
		MICME_WHISPER_STREAM_BIN: legacy,
	}));
	const environment = isolatedEnvironment(root, root);
	const runtime = runRuntimeProbe(environment);
	const doctor = runNode(["--import", noDownload, "scripts/doctor.mjs"], environment);

	assert.equal(runtime.plan.effectiveBackend, "none");
	assert.equal(runtime.plan.reason, runtime.liveError);
	assert.match(runtime.liveError, /micme-live.*not found.*MICME_LIVE_BIN.*clip mode/i);
	assert.ok(doctor.split(/\r?\n/).includes(`! effective backend: ${runtime.liveError}`), doctor);
	assert.doesNotMatch(doctor, /^✓ (?:effective backend|live worker protocol):/m);
	await assert.rejects(access(`${legacy}.args`), { code: "ENOENT" });
});

test("stream doctor warns instead of reporting an incompatible worker protocol as available", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-wrong-protocol-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const worker = join(root, "micme-live");
	await createLoggedCommand(worker, 2);
	const environment = { ...isolatedEnvironment(root, root), MICME_TRANSCRIPTION_MODE: "stream", MICME_MODEL_DIR: join(root, "models") };

	const doctor = runNode(["--import", noDownload, "scripts/doctor.mjs"], environment);

	assert.match(doctor, /^! live worker protocol unavailable: .*Worker v1.*MICME_LIVE_BIN/m);
	assert.doesNotMatch(doctor, /^✓ live worker protocol:/m);
	assert.equal(await readFile(`${worker}.args`, "utf8"), "--protocol-version\n");
});

test("clip doctor preserves auto priority for custom, cached whisper.cpp, and Python", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-clip-priority-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const binDir = join(root, "bin");
	const modelDir = join(root, "models");
	const modelPath = join(modelDir, "ggml-small.en.bin");
	const python = join(binDir, process.platform === "win32" ? "whisper.EXE" : "whisper");
	await createWhisperCppFixture(binDir);
	await writeFile(python, "discovery fixture", { mode: 0o755 });
	await mkdir(modelDir);
	await writeFile(modelPath, "cached ASR fixture");
	const baseEnv = {
		...isolatedEnvironment(root, binDir),
		MICME_TRANSCRIPTION_MODE: "clip",
		MICME_TRANSCRIBE_BACKEND: "auto",
		MICME_MODEL_DIR: modelDir,
		MICME_AUTO_DOWNLOAD_MODEL: "0",
	};
	const secret = "DOCTOR-HOOK-VALUE";
	const fixtures = [
		{ backend: "custom", overrides: { MICME_TRANSCRIBE_COMMAND: `printf ${secret} {audioRaw}` } },
		{ backend: "whisper.cpp", overrides: {} },
		{ backend: "python", overrides: { MICME_WHISPER_CPP_BIN: join(binDir, "missing-whisper-cli") } },
	];
	for (const { backend, overrides } of fixtures) {
		const environment = { ...baseEnv, ...overrides };
		const { plan } = runRuntimeProbe(environment);
		const doctor = runNode(["--import", noDownload, "scripts/doctor.mjs"], environment);
		assert.equal(plan.effectiveBackend, backend);
		assert.ok(doctor.split(/\r?\n/).includes(`✓ effective backend: ${backend} (${plan.reason})`), doctor);
		assert.doesNotMatch(doctor, /live worker protocol|model is missing/);
		if (backend === "custom") {
			assert.equal(getDoctorField(doctor, "effective model"), "unknown; controlled by MICME_TRANSCRIBE_COMMAND");
			assert.ok(!doctor.includes(secret), "doctor exposed the custom command value");
		} else {
			assert.equal(getDoctorField(doctor, "effective model name"), plan.modelName);
			assert.equal(getDoctorField(doctor, "effective model source"), plan.modelSource);
		}
		if (backend === "whisper.cpp") assert.equal(getDoctorField(doctor, "effective model path"), modelPath);
	}
});
