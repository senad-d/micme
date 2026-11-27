import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, readFileSync } from "node:fs";
import { access, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closePi, enterCommand, installedPi, isolatedPi, observedPi, promptOnScreen, recorderCommand, traceRows, waitFor } from "./live-native/transfer-pi-local.mjs";
import { addWav, devices, firstDevice, fixture, fixtureText, holdPartialDecode, installCli, log, noForbidden, originalBytes, run, secondDevice, succeeded, until, wave } from "./transfer-files-fixtures.mjs";

const here = fileURLToPath(import.meta.url);
const unix = { skip: process.platform === "win32" && "V5 POSIX command fixtures", timeout: 120_000 };
const { TRANSCRIBE_CLI_FLAGS: K, TRANSCRIBE_CLI_EXIT: status, MICME_TRANSFER_ACTIONS } = await import("../src/transfer/contracts.ts");

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

async function runImport(f, operation, ...files) {
	return succeeded(await run(process.execPath, [here, "--import-fixture", operation, ...files], { cwd: f.project, env: f.env }), operation);
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
	if (operation === "progress" || operation === "ready") {
		const { page } = await import("../src/transfer/library.ts");
		await until(async () => (await page(null)).some((row) => row.filename === files[0] && (operation === "ready"
			? row.state === "ready"
			: row.state === "recognizing" && row.doneSamples > 0 && row.doneSamples < row.totalSamples)), `import becomes ${operation === "ready" ? "ready" : "observable at a chunk boundary"}`);
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

async function piImportJourney(t, f, long, sample) {
	const capture = join(f.root, "capture.jsonl");
	const state = await isolatedPi({ root: f.root, entry: new URL("../src/extension.ts", import.meta.url).href, signal: t.signal });
	Object.assign(state.env, {
		...f.env, ...state.env,
		PATH: [f.bin, state.env.PATH].join(delimiter), MICME_DEFAULT_WHISPER_CPP_MODEL: "tiny.en",
		MICME_TRANSCRIPTION_MODE: "clip", MICME_RECORD_COMMAND: recorderCommand(sample, capture),
	});
	await symlink(f.models, join(state.project, "models"));
	await writeFile(join(f.root, "hold"), "");
	const pi = observedPi(state, installedPi, 80, t.signal);
	try {
		const screen = async (pattern, send, from = pi.frames.length) => {
			if (send) pi.send(send);
			return waitFor(() => pi.frames.slice(from).find(({ lines }) => pattern.test(lines.join("\n"))), t.signal,
				`Pi did not render ${pattern}`);
		};
		const command = async (action, pattern) => {
			const from = pi.frames.length;
			enterCommand(pi, `/micme ${action}`.trimEnd());
			if (pattern) await screen(pattern, null, from);
		};
		const logHas = (path, field, value) => waitFor(async () => (await traceRows(path)).some((row) => row[field] === value), t.signal, `Pi did not observe ${value}`);
		const ended = async () => (await traceRows(state.trace)).filter(({ kind }) => kind === "command-end").length;
		await logHas(state.trace, "kind", "started");
		await command("import", /Add files…/);
		await screen(/Ctrl\+G next/, "\r");
		await screen(/Choose installed model/, `\x1b[200~${long}\x1b[201~\x07`);
		await screen(/Queue local files\?/, "\r");
		await screen(/import · Transcribing · long 日本\.wav/i, "\x1b[B\x1b[B\r");
		const first = await until(async () => (await log(f.root))[0], "first import chunk in a real Pi session");
		const beforeDismiss = await ended();
		pi.send("\x1b");
		await waitFor(async () => (await ended()) > beforeDismiss, t.signal, "Pi overlay command did not complete after Escape");
		await command("");
		await logHas(capture, "type", "capture-first");
		await writeFile(join(f.root, `release-${first.pid}`), "");
		// Pi deliberately refuses to open the history view during an active take.
		// Observe the same live library through L's public page entry in a reader subprocess.
		const reader = { ...f, env: state.env };
		await runImport(reader, "progress", basename(long));
		assert.equal((await log(f.root)).length, 1, "a real foreground recording owns the lane after the in-flight chunk");
		const beforeCancel = await ended();
		await command("cancel");
		await logHas(capture, "type", "capture-close");
		await waitFor(async () => (await ended()) > beforeCancel, t.signal, "recording cancellation did not finish");
		const draft = "PUBLIC DRAFT: keep this text.";
		pi.send(draft);
		await waitFor(() => promptOnScreen(pi.frames.at(-1)?.lines ?? [], draft), t.signal, "draft did not render before import resumed");
		await rm(join(f.root, "hold"));
		await runImport(reader, "ready", basename(long));
		assert.ok((await log(f.root)).length > 1, "background inference resumed after cancellation");
		assert.ok(promptOnScreen(pi.frames.at(-1)?.lines ?? [], draft), "completed import must keep the visible composer intact");
		await command("history", /import · Ready · long 日本\.wav/i);
		const receipts = await traceRows(state.trace);
		assert.deepEqual(receipts.filter(({ kind }) => ["setEditorText", "pasteToEditor", "send", "blocked-input"].includes(kind)), [], "no edit, paste, send or queue from import or the canceled recording");
	} catch (error) {
		throw new Error(`${error.message}\n${pi.frames.at(-1)?.lines.join("\n") ?? ""}\n${pi.stderr()}`, { cause: error });
	} finally {
		await closePi(state);
	}
}

function cliFailure(result, expected, label) {
	assert.equal(result.status, expected, `${label}: ${result.stderr}`);
	assert.equal(result.stdout, "", label);
	assert.ok(result.stderr.trim(), label);
	assert.doesNotMatch(result.stderr, /\n\s+at\s|ERR_MODULE_NOT_FOUND|V5 forbidden effect/, label);
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
	assert.equal(succeeded(await cli([...args, audio], { PI_CODING_AGENT_DIR: "" }), "plain transcript with default config path").trimEnd(), fixtureText);
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
		[[], status.usage], [["--help"], status.usage], [["--unknown"], status.usage], [[K.listModels, K.listDevices], status.usage],
		[[K.model, model, audio], status.usage], [[K.model, "", K.device, "auto", audio], status.usage],
		[[...args, K.device, "auto", audio], status.usage], [[...args, K.repeat, "0", audio], status.usage],
		[[...args, K.repeat, "-1", audio], status.usage], [[...args, K.repeat, "1.5", audio], status.usage],
		[[...args, K.repeat, "", audio], status.usage], [[...args, K.repeat, "9".repeat(10001), audio], status.usage],
		[[...args, join(f.root, "missing.wav")], status.usage], [[...args, f.root], status.usage],
		...invalid.concat(truncated).map((file) => [[...args, K.json, file], status.usage]),
		[[K.model, "absent-模型", K.device, "auto", audio], status.failed],
		[[K.model, model, K.device, "fixture-unlisted", audio], status.failed],
	]) {
		const label = argv.map((value) => value.slice(0, 120)).join(" ");
		cliFailure(await cli(argv), expected, label);
	}
	assert.equal((await log(f.root)).length, stopped, "invalid inputs and missing selections must not reach inference");
	const failure = await cli([...args, K.repeat, "3", K.json, audio], { V5_INFERENCE_ERROR: "1" });
	cliFailure(failure, status.failed, "fixture inference failed");
	assert.match(failure.stderr, /local recognition failed/i);
	assert.doesNotMatch(failure.stderr, /V5 decoder-only diagnostic/);
	assert.equal((await log(f.root)).length, stopped + 1, "a failed repeat yields no partial JSON or further inference");
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
	for (const observed of [firstDevice.id, undefined]) {
		const mismatch = await deviceCli([K.model, model, K.device, secondDevice.id, K.json, audio], observed, "vulkan");
		cliFailure(mismatch, status.failed, "a listed ID was not bound in the file run");
		assert.match(mismatch.stderr, /did not confirm the selected device/i);
	}
	const calls = (await log(f.root)).slice(offset);
	assert.deepEqual(calls.map(({ choice }) => choice.requestedDeviceId), [secondDevice.id, null, null, null, secondDevice.id, secondDevice.id]);
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

	test("V5 S/E/L: Pi import yields to a foreground recording without editing or sending the prompt", { ...unix, skip: process.platform !== "linux" && "isolated Pi PTY requires Linux" }, async (t) => {
		const f = await fixture(t, { media: true });
		const long = await addWav(f.root, "long 日本.wav", 65 * 16000);
		const sample = await addWav(f.root, "capture.wav", 16000);
		await originalBytes([long, sample], () => piImportJourney(t, f, long, sample));
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
		assert.deepEqual((await readdir(f.models)).sort(), ["ggml-base.en.bin", "ggml-tiny.en.bin"], "installed models are unchanged");
		assert.deepEqual(await readdir(f.cache), [], "no model downloads or partial weights");
		assert.deepEqual(await readdir(f.scratch), [], "no retained audio or transcript artifacts");
	});
}
