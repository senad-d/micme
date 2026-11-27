#!/usr/bin/env node
import { constants, fstatSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { validateCompletedClipWav, WavHeaderScanner } from "../src/audio-level.ts";
import { createLiveRecordingDirectory } from "../src/recording-dir.ts";
import { sanitizeTerminalOutput } from "../src/terminal-text.ts";
import { snapshotVerifiedAudio } from "../src/transfer/capture.ts";
import { COMPUTE_MODES, TRANSCRIBE_CLI_DEFAULT_REPEAT, TRANSCRIBE_CLI_EXIT as exit, TRANSCRIBE_CLI_FLAGS as flags } from "../src/transfer/contracts.ts";
import * as installed from "../src/transfer/recognition.ts";

const usage = `Usage: micme-transcribe ${flags.listModels}|${flags.listDevices} [${flags.json}]
       micme-transcribe ${flags.model} ID ${flags.device} ${COMPUTE_MODES.join("|")}|LISTED_DEVICE_ID [${flags.repeat} N] [${flags.json}] FILE`;
const options = Object.fromEntries(Object.entries(flags).map(([key, flag]) => [flag.slice(2), {
	type: ["model", "device", "repeat"].includes(key) ? "string" : "boolean",
}]));

class UsageError extends Error {}
class SelectionError extends Error {}

function parseCommand(args) {
	const { values, positionals, tokens } = parseArgs({ args, options, allowPositionals: true, tokens: true });
	const seen = tokens.filter(({ kind }) => kind === "option").map(({ name }) => name);
	if (new Set(seen).size !== seen.length) throw new UsageError();
	const json = values[flags.json.slice(2)] === true;
	const models = values[flags.listModels.slice(2)];
	const devices = values[flags.listDevices.slice(2)];
	if (models || devices) {
		if (models && devices || positionals.length || seen.length > (json ? 2 : 1)) throw new UsageError();
		return { mode: models ? "models" : "devices", json };
	}
	const model = values[flags.model.slice(2)];
	const device = values[flags.device.slice(2)];
	const count = values[flags.repeat.slice(2)] ?? String(TRANSCRIBE_CLI_DEFAULT_REPEAT);
	const repeat = Number(count);
	if (!model?.trim() || !device?.trim() || positionals.length !== 1 || !positionals[0] || !/^\d+$/.test(count) || !Number.isSafeInteger(repeat) || repeat < 1) throw new UsageError();
	return { mode: "file", json, model, device, repeat, path: positionals[0] };
}

function invalidWav() {
	return new UsageError("Expected a complete, nonempty 16 kHz mono signed 16-bit PCM WAV.");
}

function regularFileError() {
	return new UsageError("Input must be a readable local regular file (not a symlink or device).");
}

async function openInput(path) {
	try {
		if ((await lstat(path)).isFile()) return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch { /* Do not print a user path or raw filesystem diagnostic. */ }
	throw regularFileError();
}

function stamp(stat) {
	return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function verifyInput(handle, signal) {
	const stat = await handle.stat({ bigint: true });
	if (!stat.isFile()) throw regularFileError();
	const bytes = Number(stat.size);
	if (bytes > 0xffffffff + 8) throw invalidWav();
	const fdStamp = stamp(stat);
	// A regular external file is not in an owned recording directory. Use only the
	// opened descriptor, then freeze it into the same private snapshot used by E.
	const source = {
		bytes,
		file: { async readAt(buffer, offset) { return (await handle.read(buffer, 0, buffer.length, offset)).bytesRead; } },
		check() {
			if (stamp(fstatSync(handle.fd, { bigint: true })) !== fdStamp) throw new UsageError("Input WAV changed while being read; use a completed file.");
		},
	};
	await validateCompletedClipWav(source.file, bytes, signal).catch(() => {
		signal.throwIfAborted();
		throw invalidWav();
	});
	const layout = await new WavHeaderScanner("live", invalidWav).scan(source.file, bytes, signal);
	if (!layout) throw invalidWav();
	source.check();
	return { source, samples: layout.dataBytes / layout.frameBytes };
}

async function selectChoice(command, service) {
	const choice = (await service.listInstalled()).find(({ variantId }) => variantId === command.model);
	if (!choice) throw new SelectionError(`Model is not installed or qualified. Provision local weights and check ${flags.listModels}; this command never downloads weights.`);
	if (command.device === "auto") return { ...choice, compute: "auto", requestedDeviceId: null };
	const devices = await service.listCompute();
	const backendOption = COMPUTE_MODES.includes(command.device);
	const matching = devices.filter(({ backend, device }) => backendOption ? backend === command.device : device?.id === command.device);
	if (!matching.length || !backendOption && matching.length !== 1) {
		throw new SelectionError(`Device is not available as a backend or unique device ID. Choose ${flags.device} auto or check ${flags.listDevices}.`);
	}
	return { ...choice, compute: matching[0].backend, requestedDeviceId: backendOption ? null : command.device };
}

function deviceLine({ backend, device }) {
	return [backend, ...(device ? [device.id ?? "", device.label ?? ""] : [])].map(sanitizeTerminalOutput).join("\t").trimEnd();
}

function lineList(lines) { return lines.length ? `${lines.join("\n")}\n` : ""; }

function success(value, json, text, stderr = "") {
	return { code: exit.success, stdout: json ? `${JSON.stringify(value)}\n` : text, stderr: json ? "" : stderr };
}

function assertBinding(selected, { actualCompute, boundDevice }) {
	if ((selected.requestedDeviceId !== null && selected.requestedDeviceId !== boundDevice?.id) ||
		(selected.compute !== "auto" && actualCompute !== "unknown" && actualCompute !== selected.compute)) {
		throw new SelectionError(`Recognition did not confirm the selected device. Choose ${flags.device} auto or check ${flags.listDevices}.`);
	}
}

async function runFile(command, service, signal) {
	const handle = await openInput(command.path);
	let directory;
	try {
		const { source, samples } = await verifyInput(handle, signal);
		const selected = await selectChoice(command, service);
		directory = await createLiveRecordingDirectory(process.cwd(), false, "micme-cli-");
		const audio = await snapshotVerifiedAudio(source, directory, signal);
		const runs = [];
		let result;
		try {
			for (let index = 1; index <= command.repeat; index++) {
				signal.throwIfAborted();
				const started = performance.now();
				result = await service.recognizeFile(audio, selected, "cli", ignoreProgress, signal);
				runs.push({ index, elapsedMs: performance.now() - started });
				assertBinding(selected, result);
			}
		} finally { await service.unload(); }
		signal.throwIfAborted();
		const { local: text, actualCompute: device, boundDevice, language } = result;
		const output = { model: command.model, requestedDevice: command.device, device, boundDevice, language, text, runs, audioSamples: samples };
		const summary = `Requested: ${sanitizeTerminalOutput(command.device)}; observed: ${deviceLine({ backend: device, device: boundDevice })}`;
		const timings = runs.map(({ index, elapsedMs }) => `Run ${index}: ${elapsedMs.toFixed(3)} ms`);
		return success(output, command.json, `${sanitizeTerminalOutput(text)}\n`, lineList([summary, ...timings]));
	} finally {
		try { await handle.close(); }
		finally {
			try { await directory?.remove(); }
			finally { directory?.close(); }
		}
	}
}

function ignoreProgress() { /* All completed timings are reported together. */ }

export async function transcribeWavCli(args, service = installed, signal = new AbortController().signal) {
	let command;
	try { command = parseCommand(args); }
	catch { return { code: exit.usage, stdout: "", stderr: `${usage}\n` }; }
	try {
		signal.throwIfAborted();
		if (command.mode === "models") {
			const models = [...new Set((await service.listInstalled()).map(({ variantId }) => variantId))].sort();
			return success({ models }, command.json, lineList(models.map(sanitizeTerminalOutput)));
		}
		if (command.mode === "devices") {
			const devices = await service.listCompute();
			return success({ devices }, command.json, lineList(devices.map(deviceLine)));
		}
		return await runFile(command, service, signal);
	} catch (error) {
		const expected = error instanceof UsageError || error instanceof SelectionError;
		const message = expected ? error.message : signal.aborted ? "Transcription canceled." : "Local recognition failed. Check the installed engine, weights and configuration with micme-doctor; this command never downloads weights.";
		return { code: error instanceof UsageError ? exit.usage : exit.failed, stdout: "", stderr: `${message}\n` };
	}
}

async function main() {
	// Like standalone doctor, resolve the ordinary config location without loading Pi.
	if (!process.env.PI_CODING_AGENT_DIR?.trim()) process.env.PI_CODING_AGENT_DIR = join(homedir(), ".pi", "agent");
	const controller = new AbortController();
	const abort = controller.abort.bind(controller);
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	const result = await transcribeWavCli(process.argv.slice(2), installed, controller.signal);
	process.removeListener("SIGINT", abort);
	process.removeListener("SIGTERM", abort);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exitCode = result.code;
}

if (import.meta.main) await main();
