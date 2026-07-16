import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = dirname(packagePath);
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const doctorPath = join(packageRoot, packageJson.bin["micme-doctor"].replace(/^\.\//, ""));
const runtimeProbe = `
import { resolveTranscriptionPlan } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/backends.ts")).href)};
import { getTranscriptionMode, reloadMicmeConfig } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/config.ts")).href)};
import { resolveWhisperCppModel } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/models.ts")).href)};
reloadMicmeConfig();
const model = resolveWhisperCppModel();
const plan = resolveTranscriptionPlan({ transcriptionMode: getTranscriptionMode(), whisperCppModel: model });
console.log(JSON.stringify({ model, plan }));
`;

function isolatedEnvironment(root, binDir) {
	const environment = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("MICME_") || key === "PI_CODING_AGENT_DIR" || value === undefined) continue;
		environment[key] = value;
	}
	return { ...environment, HOME: root, PATH: binDir, PI_CODING_AGENT_DIR: root };
}

function runNode(args, environment) {
	const result = spawnSync(process.execPath, args, {
		cwd: packageRoot,
		encoding: "utf8",
		env: environment,
		maxBuffer: 1024 * 1024,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

function getDoctorField(output, label) {
	const prefix = `- ${label}: `;
	const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
	assert.ok(line, `missing doctor field ${label} in:\n${output}`);
	return line.slice(prefix.length);
}

async function createWhisperCppFixture(binDir) {
	await mkdir(binDir, { recursive: true });
	const executable = join(binDir, process.platform === "win32" ? "whisper-cli.CMD" : "whisper-cli");
	await writeFile(executable, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
	if (process.platform !== "win32") await chmod(executable, 0o755);
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

test("public doctor uses the runtime model and backend contract for isolated fixtures", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "micme-doctor-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
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
		const runtime = JSON.parse(runNode(["--input-type=module", "--eval", runtimeProbe], environment));
		const doctor = runNode([doctorPath], environment);

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
