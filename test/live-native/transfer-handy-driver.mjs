// Linux-only test driver for the installed Handy v0.10.2 deb/rpm layout.
// Nothing from the caller's display, bus, playback, environment or HOME crosses
// the boundary. The supervisor and every app/helper process share the *new*
// namespaces; closing the driver ends its whole PID namespace (not host PIDs).
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

export const namespaces = Object.freeze(["user", "mnt", "pid", "net", "ipc"]);
const root = "/bench";
const sandboxDriver = "/handy-driver.mjs";
const binary = `${root}/bin/handy`;
const data = `${root}/bin/Data`;
const fixture = `${root}/fixture.wav`;
const settings = `${data}/settings_store.json`;
const display = ":92";
export const privateDisplay = "Xvfb/X11";
const runtime = "/tmp/handy-runtime"; // On the sandbox's tmpfs, not the host work root.
const bus = `unix:path=${runtime}/session-bus`;
const singleInstance = "com.pais.handy.SingleInstance";
const sink = "handy_bench";
export const loopbackSource = `${sink}.monitor`;
const pulse = `unix:${runtime}/pulse`;
const maxOutput = 4 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const portableLog = `[portable] data dir: ${data}`;
const denied = /permission denied|operation not permitted|access denied|not authorized|no permissions/i;
const toolRoot = "/usr/bin";
const requiredTools = ["bwrap", "Xvfb", "dbus-daemon", "dbus-send"];
const desktopTools = ["pulseaudio", "pactl", "pacat", "wish", "xdotool"];
const noResources = "Handy's isolated package could not start; check the installed release, its Linux runtime libraries and X11 dependencies.";

export class HandyGap extends Error {
	constructor(code, detail, outcome = "unavailable") {
		super(detail);
		this.code = code;
		this.outcome = outcome;
	}
}

export async function verifyTools(pcm) {
	for (const name of pcm ? requiredTools : [...requiredTools, ...desktopTools]) {
		try { await access(join(toolRoot, name), constants.X_OK); } catch (error) {
			throw new HandyGap(error.code === "EACCES" ? "missing-permission" : "missing-host", `Install the isolated Linux runner's ${name} system tool in /usr/bin.`);
		}
	}
}

async function appendSystemMounts(args) {
	// Only system programs/data and loader configuration; no host /etc, /tmp,
	// /run, /home, /sys, /dev/snd, /dev/input, or externally inherited sockets.
	for (const path of ["/usr/bin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/share", "/etc/ld.so.cache", "/etc/fonts", "/etc/alternatives"]) {
		if (await stat(path).catch(() => null)) args.push("--ro-bind", path, path);
	}
	for (const path of ["/bin", "/lib", "/lib64"]) {
		const info = await lstat(path).catch(() => null);
		if (info?.isSymbolicLink()) args.push("--symlink", await readlink(path), path);
		else if (info?.isDirectory()) args.push("--ro-bind", path, path);
	}
}

export async function launchHandy({ dir, resources, spec, signal }) {
	signal.throwIfAborted();
	const args = ["--unshare-all", "--unshare-user", "--as-pid-1", "--new-session", "--die-with-parent", "--cap-drop", "ALL",
		"--clearenv", "--proc", "/proc", "--dev", "/dev", "--perms", "01777", "--tmpfs", "/tmp", "--tmpfs", "/run"];
	await appendSystemMounts(args);
	const mounts = [
		[join(dir, "handy"), binary], [join(dir, "model"), `${data}/models/${spec.modelFile}`],
		[join(dir, "fixture.wav"), fixture], [join(dir, "spec.json"), `${root}/spec.json`],
		[join(dir, "passwd"), "/etc/passwd"], [join(dir, "group"), "/etc/group"], [join(dir, "machine-id"), "/etc/machine-id"],
		[resources, `${root}/lib/Handy`], [process.execPath, "/handy-node"],
		[fileURLToPath(import.meta.url), sandboxDriver],
	];
	const uid = process.getuid(), gid = process.getgid();
	await Promise.all([
		writeFile(join(dir, "spec.json"), JSON.stringify(spec), { flag: "wx", mode: 0o400 }),
		writeFile(join(dir, "passwd"), `benchmark:x:${uid}:${gid}:Handy benchmark:${root}/home:/bin/false\n`, { flag: "wx", mode: 0o400 }),
		writeFile(join(dir, "group"), `benchmark:x:${gid}:\n`, { flag: "wx", mode: 0o400 }),
		writeFile(join(dir, "machine-id"), `${randomBytes(16).toString("hex")}\n`, { flag: "wx", mode: 0o400 }),
	]);
	args.push("--bind", join(dir, "state"), root);
	for (const [source, target] of mounts) args.push("--ro-bind", source, target);
	if (spec.pinSilero) args.push("--ro-bind", join(dir, "silero"), `${root}/lib/Handy/resources/models/silero-vad-v6.2-F32.gguf`);
	args.push("--symlink", "Handy", `${root}/lib/handy`);
	const isolatedEnv = {
		PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: `${root}/home`, TMPDIR: "/tmp", USER: "benchmark", LOGNAME: "benchmark",
		XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, XDG_CACHE_HOME: `${root}/cache`,
		XDG_STATE_HOME: `${root}/state`, XDG_RUNTIME_DIR: runtime, XDG_SESSION_TYPE: "x11",
		DISPLAY: display, GDK_BACKEND: "x11", HANDY_GDK_BACKEND: "x11", HANDY_NO_GTK_LAYER_SHELL: "1",
		DBUS_SESSION_BUS_ADDRESS: bus, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime}/no-system-bus`,
		PULSE_SERVER: pulse, PULSE_RUNTIME_PATH: runtime, PULSE_SOURCE: loopbackSource, PULSE_SINK: sink,
		PULSE_CLIENTCONFIG: `${root}/pulse-client.conf`, HF_HOME: `${root}/models-cache`, HF_HUB_OFFLINE: "1",
		RUST_LOG: "handy_app_lib=debug", NO_AT_BRIDGE: "1",
	};
	for (const [key, value] of Object.entries(isolatedEnv)) args.push("--setenv", key, value);
	args.push("--chdir", root, "--", "/handy-node", sandboxDriver);
	signal.throwIfAborted();
	const child = running(spawn("/usr/bin/bwrap", args, { env: {}, stdio: "pipe" }));
	const output = [];
	let overflow = false;
	let count = 0;
	child.proc.stdout.on("data", (chunk) => {
		count += chunk.length;
		if (count > maxOutput) { overflow = true; child.proc.kill("SIGKILL"); }
	});
	const lines = createInterface({ input: child.proc.stdout });
	lines.on("line", (line) => {
		if (overflow) return;
		try { output.push(JSON.parse(line)); } catch { /* Only private structured observations cross to the runner. */ }
	});
	const stderr = boundedText(child.proc.stderr);
	const closing = () => child.proc.stdin.end();
	const kill = () => child.proc.kill("SIGKILL");
	let timer;
	const cancel = () => { closing(); timer = setTimeout(kill, 500); };
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	try {
		const exit = await child.exited;
		if (signal.aborted) output.push({ kind: "result", outcome: "lost", code: "canceled", detail: "Owned Handy take interrupted." });
		else if (overflow) output.push({ kind: "result", outcome: "failed", code: "no-result", detail: "Owned observer exceeded the trace limit." });
		else if (!output.some((o) => o.kind === "result")) {
			if (!output.length) throw new HandyGap(denied.test(stderr()) ? "missing-permission" : "missing-host",
				"Bubblewrap could not start the private namespaces and the owned Node driver; no Handy command ran.");
			output.push({ kind: "result", outcome: "failed", code: "no-result", detail: "Owned Handy driver exited without a final result." });
		} else if (exit.code !== 0) output.push({ kind: "result", outcome: "failed", code: "no-result", detail: "Owned Handy driver did not exit cleanly." });
		return output;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
		closing();
		lines.close();
	}
}

function running(proc) {
	proc.stdin.on("error", () => {}); // Early owned exit closes the command pipe.
	const exited = new Promise((done) => {
		let error;
		proc.once("error", (value) => { error = value; });
		proc.once("close", (code, signal) => done({ code, signal, error }));
	});
	return { proc, exited, alive: () => !!proc.pid && proc.exitCode === null && proc.signalCode === null };
}

function boundedText(stream) {
	let text = "";
	stream.setEncoding("utf8");
	stream.on("data", (data) => { text = (text + data).slice(-maxOutput); });
	return () => text;
}

async function command(proc, timeout = 4_000) {
	const job = running(proc);
	job.proc.stdin.end();
	const stdout = boundedText(job.proc.stdout), stderr = boundedText(job.proc.stderr);
	const timer = setTimeout(() => job.proc.kill("SIGKILL"), timeout);
	try { return { ...(await job.exited), stdout: stdout(), stderr: stderr() }; } finally { clearTimeout(timer); }
}

function service(proc) {
	const job = running(proc);
	job.stderr = boundedText(job.proc.stderr);
	job.proc.stdout.resume();
	return job;
}

function report(kind, fields = {}) {
	process.stdout.write(`${JSON.stringify({ kind, ns: process.hrtime.bigint().toString(), ...fields })}\n`);
}

function event(stage) { report("event", { stage }); }

async function waitFor(check, timeout, gap) {
	const start = process.hrtime.bigint();
	for (;;) {
		const value = await check();
		if (value) return value;
		if (process.hrtime.bigint() - start >= BigInt(timeout) * 1_000_000n) throw gap;
		await delay(20);
	}
}

function serviceAlive(job, name) {
	if (!job.alive()) throw new HandyGap(denied.test(job.stderr()) ? "missing-permission" : "missing-host", `The private ${name} service did not start or exited.`);
}

async function socketOwned(path) {
	const info = await lstat(path).catch(() => null);
	return info?.isSocket() && info.uid === process.getuid();
}

function busCommand(method, args = []) {
	return command(spawn("/usr/bin/dbus-send", ["--session", "--print-reply", "--reply-timeout=1000", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", `org.freedesktop.DBus.${method}`, ...args]));
}

async function setup(spec) {
	const current = await Promise.all(namespaces.map((name) => readlink(`/proc/self/ns/${name}`)));
	const outside = ["/home", "/dev/snd", "/dev/dri", "/dev/input", "/run/user", "/run/dbus/system_bus_socket"];
	if (process.pid !== 1 || !spec.ns || current.some((value, i) => !spec.ns[i] || value === spec.ns[i]) ||
		(await Promise.all(outside.map((path) => lstat(path).catch(() => null)))).some(Boolean)) {
		throw new HandyGap("unsafe-instance", "Could not prove separate user, mount, PID, IPC, and network namespaces with no host devices or session.");
	}
	await mkdir(runtime, { mode: 0o700 });
	for (const name of ["home", "config", "data", "cache", "state", "models-cache"]) await mkdir(`${root}/${name}`, { mode: 0o700 });
	const preference = {
		selected_model: spec.modelId, selected_language: spec.language, translate_to_english: spec.translate,
		onboarding_completed: true, auto_submit: false, post_process_enabled: false, external_script_path: null,
		always_on_microphone: false, selected_microphone: null, selected_channel: null, clamshell_microphone: null,
		audio_feedback: false, mute_while_recording: false, append_trailing_space: false,
		start_hidden: true, autostart_enabled: false, update_checks_enabled: false, show_whats_new_on_update: false,
		keyboard_implementation: "none", shortcut_activation: "toggle", paste_method: "ctrl_v", clipboard_handling: "dont_modify", reliable_paste: false,
	};
	if (spec.requestedDevice === "cpu") preference.transcribe_accelerator = "cpu";
	if (spec.vad === "off") preference.vad_enabled = false;
	if (spec.vad === "silero" || spec.vad === "earshot") { preference.vad_enabled = true; preference.vad_backend = spec.vad; }
	if (spec.chunk === "off" || spec.chunk === "on" || spec.chunk === "pause-aware") preference.long_form_chunking = spec.chunk !== "off";
	await Promise.all([
		writeFile(`${root}/bin/portable`, "Handy Portable Mode\n", { flag: "wx" }),
		writeFile(settings, JSON.stringify({ settings: preference }), { flag: "wx" }),
		writeFile(`${root}/bus.conf`, `<busconfig><type>session</type><listen>${bus}</listen><auth>EXTERNAL</auth><policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`, { flag: "wx" }),
		writeFile(`${root}/pulse-client.conf`, "autospawn = no\nenable-shm = no\n", { flag: "wx" }),
	]);
	const x = service(spawn("/usr/bin/Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-noreset", "-ac"]));
	const dbus = service(spawn("/usr/bin/dbus-daemon", ["--nofork", `--config-file=${root}/bus.conf`]));
	await waitFor(async () => {
		serviceAlive(x, "Xvfb"); serviceAlive(dbus, "D-Bus");
		return await socketOwned("/tmp/.X11-unix/X92") && await socketOwned(`${runtime}/session-bus`) && (await busCommand("ListNames")).code === 0;
	}, 5_000, new HandyGap("unsafe-instance", "Could not verify the private X11 and D-Bus sockets."));
	return preference;
}

function parseModeResult(result, failure = "missing-host") {
	if (result.code !== 0 || !result.stderr.includes(portableLog)) {
		throw new HandyGap(denied.test(result.stderr) ? "missing-permission" : failure, failure === "missing-host" ? noResources : "The pinned installed-model WAV CLI did not complete.", failure === "no-result" ? "failed" : "unavailable");
	}
	try { return JSON.parse(result.stdout); } catch { throw new HandyGap("no-result", "Could not read Handy's machine-readable CLI output.", "failed"); }
}

async function verifyModel(spec) {
	const rows = parseModeResult(await command(spawn("/bench/bin/handy", ["--list-models", "--json"]), 20_000));
	const matches = Array.isArray(rows) ? rows.filter((row) => row.id === spec.modelId && row.filename === spec.modelFile && row.is_downloaded === true) : [];
	const files = await readdir(`${data}/models`);
	if (matches.length !== 1 || files.length !== 1 || files[0] !== spec.modelFile) {
		throw new HandyGap("identity-mismatch", "Handy's private installed registry did not bind only the exact frozen filename to the supplied model ID.");
	}
	const [model] = matches;
	const digest = model.source?.Url?.sha256;
	const revision = model.source?.HuggingFace?.revision;
	if ((digest && digest !== spec.modelDigest) || (revision && spec.modelRevision && revision !== spec.modelRevision)) {
		throw new HandyGap("identity-mismatch", "The supplied weight does not match the pinned Handy registry's declared digest or revision.");
	}
	const base = spec.language.split("-")[0];
	if ((spec.translate && model.supports_translation !== true) || (base !== "auto" && model.supported_languages?.length && !model.supported_languages.includes(base))) {
		throw new HandyGap("unsupported", "The installed Handy model does not support the requested language or translation task.");
	}
}

function observeBinding(text, spec) {
	const match = /Loaded transcribe-cpp model '([^']+)' \(requested .*?, requested device .*?, bound backend '([^']*)', bound device '([^']*)', supports_streaming=(true|false),/u.exec(text);
	if (!match || match[1] !== spec.modelId) return false;
	event("modelLoaded");
	report("binding", { backend: match[2], device: match[3], streaming: match[4] === "true" });
	return true;
}

async function fileTake(spec) {
	const ns = process.hrtime.bigint().toString();
	const job = running(spawn("/bench/bin/handy", ["--transcribe-file", fixture, "--model", spec.modelId, "--json"]));
	job.proc.once("spawn", () => report("event", { stage: "trigger", ns }));
	job.proc.stdin.end();
	const stdout = boundedText(job.proc.stdout), stderr = boundedText(job.proc.stderr);
	const logs = createInterface({ input: job.proc.stderr });
	let bound = false;
	logs.on("line", (line) => { if (!bound) bound = observeBinding(stripVTControlCharacters(line), spec); });
	const result = parseModeResult({ ...(await job.exited), stdout: stdout(), stderr: stderr() }, "no-result");
	if (!result || result.model !== spec.modelId || result.requested_device !== "settings" ||
		!Number.isFinite(result.audio_secs) || Math.abs(result.audio_secs - spec.bytes / 32_000) > 1e-8) {
		throw new HandyGap("identity-mismatch", "WAV CLI reported a different installed model or consumed PCM length.", "failed");
	}
	if (typeof result.text !== "string" || result.text.includes("\0") || !Array.isArray(result.transcribe_ms) || result.transcribe_ms.length !== 1 ||
		!Number.isFinite(result.transcribe_ms[0]) || result.transcribe_ms[0] < 0) throw new HandyGap("no-result", "WAV CLI returned no usable final text or single-run compute duration.", "failed");
	if (!bound && typeof result.bound_backend === "string") report("binding", { backend: result.bound_backend });
	event("rawFinal");
	report("result", { outcome: "completed", text: result.text, computeMs: result.transcribe_ms[0], consumed: true });
}

// A real Tk Text widget, not a clipboard listener. The command proxy catches
// edits even when Tk combines them into a single <<Modified>> notification.
const receiverScript = `
proc wire {kind args} { puts [join [linsert $args 0 $kind] [format %c 9]]; flush stdout }
proc encode {value} { binary encode base64 [encoding convertto utf-8 $value] }
proc contents {} { readText get 1.0 end-1c }
proc editor {op args} {
  set change [expr {$op in {insert delete replace} || ($op eq "edit" && [lindex $args 0] in {undo redo})}]
  if {$change} { set before [contents] }
  set result [readText $op {*}$args]
  if {$change && $before ne [contents]} { wire edit [encode [contents]] }
  return $result
}
proc control {} {
  if {[gets stdin op] < 0} { if {[eof stdin]} { exit }; return }
  if {$op eq "focus"} { raise .; focus -force .editor }
  if {$op eq "snapshot"} { wire snapshot [encode [contents]] }
  if {$op eq "who"} { wire focus [expr {[focus] eq ".editor"}] }
}
wm title . {Handy benchmark receiver}
wm overrideredirect . 1
text .editor -width [lindex $argv 0] -height 10 -undo 1 -wrap word
set input [open [lindex $argv 1] r]
fconfigure $input -translation binary -encoding utf-8
.editor insert end [read $input]
close $input
pack .editor
update idletasks
rename .editor readText
interp alias {} .editor {} editor
bind .editor <FocusOut> { wire blur }
bind .editor <Control-KeyPress-v> { event generate .editor <<Paste>>; break }
bind .editor <KeyPress-Return> { wire submit; break }
bind .editor <KeyPress-KP_Enter> { wire submit; break }
fileevent stdin readable control
wire ready [list [winfo id .editor] [winfo id .] [wm frame .]] [encode [contents]]
`;

async function receiver(spec) {
	await writeFile(`${root}/prefix`, spec.prefix, { flag: "wx" });
	await writeFile(`${root}/receiver.tcl`, receiverScript, { flag: "wx" });
	const job = running(spawn("/usr/bin/wish", [`${root}/receiver.tcl`, String(spec.width), `${root}/prefix`]));
	boundedText(job.proc.stderr);
	const state = { ids: [], text: null, active: false, blurred: false, snapshots: 0, focused: false, focusChecks: 0, invalid: false };
	const lines = createInterface({ input: job.proc.stdout });
	lines.on("line", (line) => {
		const [kind, first, second] = line.split("\t");
		try {
			if (kind === "ready") { state.ids = first.split(" ").map(Number); state.text = utf8.decode(Buffer.from(second, "base64")); }
			if (kind === "focus") { state.focused = first === "1"; state.focusChecks++; }
			if (kind === "blur" && state.active) state.blurred = true;
			if (kind === "edit" || kind === "snapshot") {
				const value = utf8.decode(Buffer.from(first, "base64"));
				if (value.includes("\0")) { state.invalid = true; return; }
				if (kind === "edit" && state.active) report("mutation", { text: value });
				state.text = value;
				if (kind === "snapshot") state.snapshots++;
			}
			if (kind === "submit" && state.active) report("submit");
		} catch { state.invalid = true; }
	});
	await waitFor(() => job.alive() && state.ids.length > 0 && state.ids.every((id) => Number.isSafeInteger(id) && id > 0) && state.text === spec.prefix && !state.invalid, 4_000,
		new HandyGap("no-observer", "The controlled Tk receiver did not expose its expected initial field."));
	return { job, state };
}

async function ownsFocus({ job, state }) {
	if (!job.alive() || state.invalid || state.blurred) return false;
	const checks = state.focusChecks;
	job.proc.stdin.write("who\n");
	const result = await command(spawn("/usr/bin/xdotool", ["getwindowfocus", "-f"]));
	if (result.code !== 0 || !state.ids.includes(Number(result.stdout.trim()))) return false;
	return waitFor(() => state.focusChecks > checks && state.focused, 250,
		new HandyGap("no-observer", "The active X11 receiver did not prove focus in the Tk text field.")).catch(() => false);
}

async function pulseCommand(noun) {
	const result = await command(spawn("/usr/bin/pactl", ["-f", "json", "list", noun]));
	if (result.code !== 0) return null;
	try { return JSON.parse(result.stdout); } catch { return null; }
}

async function startAudio() {
	await writeFile(`${root}/pulse.pa`, [
		`load-module module-native-protocol-unix socket=${runtime}/pulse auth-anonymous=1`,
		`load-module module-null-sink sink_name=${sink} format=s16le rate=16000 channels=1 channel_map=mono`,
		`set-default-sink ${sink}`, `set-default-source ${loopbackSource}`, "",
	].join("\n"), { flag: "wx" });
	const job = service(spawn("/usr/bin/pulseaudio", ["-n", "--daemonize=no", "--exit-idle-time=-1", "--fail=yes", "--disable-shm=yes", "-F", `${root}/pulse.pa`]));
	await waitFor(() => { serviceAlive(job, "PulseAudio"); return socketOwned(`${runtime}/pulse`); }, 5_000,
		new HandyGap("unsafe-instance", "The private audio socket could not be verified."));
	return job;
}

async function proveIdleAudio(job) {
	serviceAlive(job, "PulseAudio");
	const [sources, sinks, streams, choice] = await Promise.all([pulseCommand("sources"), pulseCommand("sinks"), pulseCommand("source-outputs"),
		command(spawn("/usr/bin/pactl", ["get-default-source"]))]);
	if (sources?.length !== 1 || sources[0].name !== loopbackSource || sinks?.length !== 1 || sinks[0].name !== sink ||
		streams?.length !== 0 || choice.code !== 0 || choice.stdout.trim() !== loopbackSource) {
		throw new HandyGap("unsafe-instance", "The isolated PulseAudio server has no provable exclusive loopback source or has unexpected idle clients.");
	}
	return sources[0].index;
}

async function ownsInstance(job, state) {
	if (!job.alive() || !state.portable || !state.handler) return false;
	const result = await busCommand("GetConnectionUnixProcessID", [`string:${singleInstance}`]);
	if (result.code !== 0 || Number(/\buint32 (\d+)/u.exec(result.stdout)?.[1]) !== job.proc.pid) return false;
	const [started, pinned] = await Promise.all([stat(`/proc/${job.proc.pid}/exe`).catch(() => null), stat(binary)]);
	return job.alive() && started?.dev === pinned.dev && started.ino === pinned.ino;
}

export function desktopLog(spec, state, plain) {
	state.portable ||= plain.includes(portableLog);
	// The pinned Linux release registers only SIGUSR2 and logs the singular form.
	state.handler ||= plain.includes("Signal handler registered (SIGUSR2; SIGUSR1 is left to WebKitGTK)");
	if (!state.bound) state.bound = observeBinding(plain, spec);
	if (!state.active) return;
	if (!state.ready && plain.includes("Microphone is receiving samples; recording is ready")) { state.ready = true; event("firstSample"); }
	if (!state.drained && plain.includes("Recording stopped and samples retrieved in")) { state.drained = true; event("drained"); }
	if (!state.final && /Transcription completed in [0-9.]+s for [0-9.]+s of audio/u.test(plain)) { state.final = true; event("rawFinal"); }
	if (plain.includes("Text pasted successfully in")) state.end = "pasted";
	if (/Recording produced no audio samples|No samples retrieved from recording stop|The microphone sent only digital silence|Transcription result is empty/u.test(plain)) state.end = "empty";
	if (/Failed to start recording:|Transcription failed:|Failed to paste transcription:/u.test(plain)) state.failure = denied.test(plain) ? "missing-permission" : "no-result";
}

async function desktopReady(spec) {
	const job = running(spawn("/bench/bin/handy", ["--start-hidden"]));
	job.proc.stdin.end();
	const state = { active: false, handler: false, portable: false, failure: null, end: null };
	const stderr = boundedText(job.proc.stderr);
	for (const stream of [job.proc.stdout, job.proc.stderr]) {
		const lines = createInterface({ input: stream });
		lines.on("line", (line) => desktopLog(spec, state, stripVTControlCharacters(line)));
	}
	await waitFor(async () => {
		if (!job.alive()) throw new HandyGap(denied.test(stderr()) ? "missing-permission" : "missing-host", noResources);
		return ownsInstance(job, state);
	}, 20_000, new HandyGap("unsafe-instance", "The portable Handy process did not prove it owns the private single-instance bus and SIGUSR2 handler."));
	return { job, state };
}

function desktopHealth(app, target) {
	if (!app.job.alive()) throw new HandyGap("no-result", "The owned Handy process exited during the take.", "failed");
	if (app.state.failure) throw new HandyGap(app.state.failure, "Handy reported a capture, recognition or paste failure.", "failed");
	if (!target.job.alive() || target.state.blurred || target.state.invalid) throw new HandyGap("unsafe-instance", "The controlled editor lost focus or observer ownership during the take.", "failed");
}

async function verifyPrivateSettings(expected) {
	const [file, history, recordings] = await Promise.all([lstat(settings), lstat(`${data}/history.db`), lstat(`${data}/recordings`)]).catch(() => []);
	if (!file?.isFile() || !history?.isFile() || !recordings?.isDirectory() || [file, history, recordings].some((entry) => entry.uid !== process.getuid())) {
		throw new HandyGap("unsafe-instance", "Could not verify the private settings and history roots before recording.");
	}
	const actual = JSON.parse(await readFile(settings, "utf8"))?.settings;
	if (Object.entries(expected).some(([key, value]) => actual?.[key] !== value)) {
		throw new HandyGap("unsafe-instance", "Could not verify the isolated app settings before recording.");
	}
}

async function verifyCaptureRoute(app, target, index) {
	await waitFor(async () => {
		desktopHealth(app, target);
		const streams = await pulseCommand("source-outputs");
		if (streams?.some((stream) => Number(stream.source) !== Number(index) || Number(stream.properties?.["application.process.id"]) !== app.job.proc.pid)) {
			throw new HandyGap("unsafe-instance", "A capture stream was not bound to the owned Handy PID and private loopback source.", "failed");
		}
		return streams?.length === 1 && app.state.ready;
	}, 8_000, new HandyGap("no-observer", "The owned Handy capture stream did not prove private loopback sample readiness; no fixture was played.", "failed"));
	report("route", { source: loopbackSource });
}

async function playPaced(spec) {
	const start = process.hrtime.bigint();
	const play = running(spawn("/usr/bin/pacat", ["--playback", "--raw", "--device", sink, "--rate=16000", "--format=s16le", "--channels=1", "--latency-msec=40"]));
	play.proc.stdout.resume();
	const stderr = boundedText(play.proc.stderr);
	const fed = pipeline(createReadStream(fixture, { start: 44 }), play.proc.stdin).then(() => true, () => false);
	const [exit, wrote] = await Promise.all([play.exited, fed]);
	if (exit.code !== 0 || !wrote || Number(process.hrtime.bigint() - start) / 1e6 + 25 < spec.bytes / 32) {
		throw new HandyGap(denied.test(stderr()) ? "missing-permission" : "no-result", "Public fixture playback did not drain at the private sink's real-time rate.", "failed");
	}
}

async function finalText(state) {
	if (state.end === "empty") return "";
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(`${data}/history.db`, { readOnly: true });
		try {
			const rows = db.prepare("SELECT transcription_text, post_processed_text FROM transcription_history LIMIT 2").all();
			return rows.length === 1 && rows[0].post_processed_text === null && typeof rows[0].transcription_text === "string" && !rows[0].transcription_text.includes("\0") ? rows[0].transcription_text : null;
		} finally { db.close(); }
	} catch { return null; }
}

function toggleOwned(job, stage) {
	const ns = process.hrtime.bigint().toString();
	if (!job.alive() || !job.proc.kill("SIGUSR2")) throw new HandyGap("unsafe-instance", "The owned Handy process disappeared before toggling recording.", "failed");
	report("event", { stage, ns });
}

async function desktopTake(spec, preference) {
	const audio = await startAudio();
	const target = await receiver(spec);
	const app = await desktopReady(spec);
	await verifyPrivateSettings(preference);
	const sourceIndex = await proveIdleAudio(audio);
	report("idleAudio");
	target.job.proc.stdin.write("focus\n");
	const focusGap = new HandyGap("unsafe-instance", "The owned external editor is not the current focused receiver.");
	await waitFor(() => ownsFocus(target), 3_000, focusGap);
	if (!await ownsInstance(app.job, app.state) || !await ownsFocus(target)) throw focusGap;
	report("receiver");
	target.state.active = app.state.active = true;
	toggleOwned(app.job, "trigger");
	if (spec.fixture === "immediate") await delay(spec.bytes / 32); // Fixture's digital zero is the idle null sink; no ready wait here.
	else { await verifyCaptureRoute(app, target, sourceIndex); await playPaced(spec); }
	desktopHealth(app, target);
	if (spec.fixture !== "immediate" && (!await ownsInstance(app.job, app.state) || !await ownsFocus(target))) throw focusGap;
	toggleOwned(app.job, "stopGesture");
	await waitFor(() => { desktopHealth(app, target); return app.state.end; }, 90_000,
		new HandyGap("no-result", "No observed Handy final or paste completion before the reference deadline.", "timeout"));
	const snapshots = target.state.snapshots;
	target.job.proc.stdin.write("snapshot\n");
	await waitFor(() => { desktopHealth(app, target); return target.state.snapshots > snapshots; }, 3_000,
		new HandyGap("no-observer", "The editor did not confirm its final field contents.", "failed"));
	if (!await ownsFocus(target)) throw focusGap;
	const final = { text: await finalText(app.state), observedTarget: target.state.text };
	const missed = app.state.end === "pasted" && final.observedTarget === spec.prefix;
	if (missed) report("result", { outcome: "failed", code: "no-result", detail: "Handy reported a paste, but the owned editor stayed unchanged.", ...final });
	else report("result", { outcome: "completed", ...final });
}

async function ownedDriver() {
	// This is a private subprocess, never a fallback that can run outside bwrap.
	process.stdin.resume();
	process.stdin.on("end", () => process.exit(0));
	const spec = JSON.parse(await readFile(`${root}/spec.json`, "utf8"));
	const preference = await setup(spec);
	await verifyModel(spec);
	if (spec.pcm) await fileTake(spec);
	else await desktopTake(spec, preference);
}

if (process.argv[1] === sandboxDriver) {
	try { await ownedDriver(); } catch (error) {
		const gap = error instanceof HandyGap ? error : new HandyGap(denied.test(error?.message ?? "") ? "missing-permission" : "no-result",
			"The private Handy driver could not complete collection.", "failed");
		report("result", { outcome: gap.outcome, code: gap.code, detail: gap.message });
	}
	// Finish the observation pipe, then let the sandbox reap *all* descendants.
	process.stdout.write("", () => process.exit(0));
}
