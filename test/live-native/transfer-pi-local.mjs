import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { wavHeader } from "./corpus.mjs";
import { withInterrupts } from "./transfer-runner.mjs";

export const checkout = fileURLToPath(new URL("../../", import.meta.url));
export const installedPi = join(checkout, "node_modules/.bin/pi");
export const publicPrefix = "PUBLIC BENCHMARK:";
const publicWords = "Public sample for the isolated Pi replay.";
export const alternateM = "\x1bm";
const harness = fileURLToPath(import.meta.url);
const recorder = fileURLToPath(new URL("paced-recorder.mjs", import.meta.url));
const sh = (text) => `'${text.replaceAll("'", "'\\''")}'`;

// Linux PTY supervisor. The recording code may create its own process group, so
// adopt and reap descendants as well as signaling the leader. No host INET
// sockets are available to the launched program or its descendants (including
// native executables). A supplied test provider is relayed on an owned Unix socket.
const supervisor = String.raw`
import ctypes, errno, os, pty, select, signal, socket, sys, termios, time, tty
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    sys.exit('Pi replay requires a Linux child subreaper')
sec = ctypes.CDLL('libseccomp.so.2')
sec.seccomp_init.argtypes = [ctypes.c_uint32]
sec.seccomp_init.restype = ctypes.c_void_p
sec.seccomp_load.argtypes = [ctypes.c_void_p]
sec.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
sec.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
class Compare(ctypes.Structure):
    _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int), ('a', ctypes.c_uint64), ('b', ctypes.c_uint64)]
policy = sec.seccomp_init(0x7fff0000)
deny = 0x00050000 | errno.EPERM
number = sec.seccomp_syscall_resolve_name
if not policy or sec.seccomp_rule_add_array(policy, deny, number(b'socket'), 1, ctypes.byref(Compare(0, 1, socket.AF_UNIX, 0))) != 0 or sec.seccomp_rule_add(policy, deny, number(b'io_uring_setup'), 0) != 0 or sec.seccomp_load(policy) != 0:
    sys.exit('Could not install the Pi replay socket policy')
direct = sys.argv[1] == 'exec'
interactive = not direct and os.isatty(0) and os.isatty(1)
if direct:
    pid, fd = os.fork(), None
else:
    size = termios.tcgetwinsize(0) if interactive else (55, int(sys.argv[1]))
    pid, fd = pty.fork()
if pid == 0:
    if not direct: termios.tcsetwinsize(0, size)
    os.execv(sys.argv[2], sys.argv[2:])
old = termios.tcgetattr(0) if interactive else None
stopping = False
def stop(*_):
    global stopping
    stopping = True
def resize(*_):
    if interactive:
        termios.tcsetwinsize(fd, termios.tcgetwinsize(0))
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, stop)
signal.signal(signal.SIGWINCH, resize)
status = None
try:
    if old: tty.setraw(0)
    inputs = [fd, 0]
    while not stopping:
        if direct:
            done, code = os.waitpid(pid, os.WNOHANG)
            if done:
                status = code
                break
            time.sleep(.025)
            continue
        ready, _, _ = select.select(inputs, [], [], 0.1)
        if fd in ready:
            try: data = os.read(fd, 65536)
            except OSError as e:
                if e.errno != errno.EIO: raise
                break
            if not data: break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data: break
            os.write(fd, data)
    if not stopping and status is None:
        done, code = os.waitpid(pid, os.WNOHANG)
        if done: status = code
finally:
    if old: termios.tcsetattr(0, termios.TCSADRAIN, old)
    if fd is not None: os.close(fd)
    for sig, seconds in ((signal.SIGTERM, .35), (signal.SIGKILL, .35)):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                done, code = os.waitpid(-1, os.WNOHANG)
                if done == pid: status = code
                if done: continue
            except ChildProcessError: break
            with open(f'/proc/self/task/{os.getpid()}/children') as owned:
                for child in owned.read().split():
                    try: os.kill(int(child), sig)
                    except ProcessLookupError: pass
            time.sleep(.015)
if status is None: sys.exit(130 if stopping else 1)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

// Reduce only the terminal protocol used by Pi (not API writes) to screen cells.
// Inspect once per synchronized frame; cursor hide/show and styles are not text.
export class Screen {
	#lines = [];
	#row = 0;
	#col = 0;
	#buffer = "";
	#synchronized = false;
	constructor(width, frame) { this.width = width; this.frame = frame; }

	write(data) {
		this.#buffer += data;
		let dirty = false;
		while (this.#buffer) {
			const escape = this.#buffer[0] === "\x1b";
			const token = (escape ? /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_G][\s\S]*?(?:\x07|\x1b\\)|\x1b[^[\]P_G])/u : /^[^\x1b]+/u).exec(this.#buffer)?.[0];
			if (!token) break;
			this.#buffer = this.#buffer.slice(token.length);
			if (token === "\x1b[?2026h") this.#synchronized = true;
			else if (token === "\x1b[?2026l") {
				this.#synchronized = false;
				this.frame(this.lines());
				dirty = false;
			} else if (escape) dirty = this.#control(token) || dirty;
			else { this.#print(token); dirty = true; }
		}
		if (dirty && !this.#synchronized && !this.#buffer) this.frame(this.lines());
	}

	lines() { return this.#lines.map((row) => row?.map((cell) => cell ?? " ").join("").trimEnd() ?? ""); }

	#control(token) {
		const [, args, op] = /^\x1b\[([\d;]*)([A-Za-z])$/u.exec(token) ?? [];
		const [a, b] = args?.split(";").map(Number) ?? [];
		if (op === "A") this.#row = Math.max(0, this.#row - (a || 1));
		else if (op === "B") this.#row += a || 1;
		else if (op === "C") this.#col = Math.min(this.width - 1, this.#col + (a || 1));
		else if (op === "D") this.#col = Math.max(0, this.#col - (a || 1));
		else if (op === "G") this.#col = (a || 1) - 1;
		else if (op === "H" || op === "f") { this.#row = (a || 1) - 1; this.#col = (b || 1) - 1; }
		else if (op === "J" && a === 2) { this.#lines = []; return true; }
		else if (op === "K") {
			this.#lines[this.#row] ??= [];
			if (a === 2) this.#lines[this.#row] = [];
			else this.#lines[this.#row].length = Math.min(this.#col, this.#lines[this.#row].length);
			return true;
		}
		return false;
	}

	#print(text) {
		for (const ch of text) {
			if (ch === "\r") this.#col = 0;
			else if (ch === "\n") { this.#row++; this.#col = 0; }
			else if (ch === "\b") this.#col = Math.max(0, this.#col - 1);
			else if (ch >= " " && ch !== "\x7f") {
				const width = visibleWidth(ch);
				if (width > 0 && this.#col + width > this.width) { this.#row++; this.#col = 0; }
				if (this.#row >= 55) { this.#lines.splice(0, this.#row - 54); this.#row = 54; }
				const row = this.#lines[this.#row] ??= [];
				if (!width) { if (this.#col) row[this.#col - 1] = (row[this.#col - 1] ?? "") + ch; continue; }
				while (row.length < this.#col) row.push(" ");
				row[this.#col++] = ch;
				for (let cell = 1; cell < width; cell++) row[this.#col++] = "";
			}
		}
	}
}

const instrumentation = String.raw`
const time = () => Number(process.hrtime.bigint()) / 1e6;
function log(kind, fields = {}) { appendFileSync(trace, JSON.stringify({ kind, t: time(), ...fields }) + '\n'); }
function observe(callback, kind) {
  return async (event, ctx) => {
    const ui = new Proxy(ctx.ui, {get(target, key) {
      if (key !== 'setEditorText' && key !== 'pasteToEditor') return target[key];
      return (...args) => { const result = target[key](...args); log(key, {text: target.getEditorText()}); return result; };
    }});
    if (kind) log(kind, {action: typeof event === 'string' ? event : ''});
    try { return await callback(event, new Proxy(ctx, {get: (target, key) => key === 'ui' ? ui : target[key]})); }
    finally { if (kind) log(kind + '-end'); }
  };
}
export default function(pi) {
  // Block all model prompts, including accidental Enter and extension auto-send.
  // Pi dispatches actual extension commands before delivering generic input.
  pi.on('input', (event, ctx) => {
    log('blocked-input');
    ctx.ui.notify('Isolated replay: coding prompts are disabled.', 'warning');
    return {action:'handled'};
  });
  pi.on('session_start', () => log('started'));
  pi.registerCommand('transfer-restart', {description: 'Restart this disposable Pi session', handler: (_args, ctx) => {
    writeFileSync(restart, ''); ctx.shutdown();
  }});
  const api = new Proxy(pi, {get(target, key) {
    // Record a sent/queued attempt as a benchmark violation, but never forward it.
    if (key === 'sendUserMessage') return (_text, options) => { log('send', {queued: !!options?.deliverAs}); };
    if (key === 'registerCommand') return (name, spec) => target[key](name, {...spec, handler: observe(spec.handler, name === 'micme' ? 'command' : null)});
    if (key === 'registerShortcut') return (name, spec) => target[key](name, {...spec, handler: ctx => observe((_event, wrapped) => spec.handler(wrapped), 'shortcut')(null, ctx)});
    return target[key];
  }});
  if (typeof micme === 'function') micme(api);
}
`;

export async function traceRows(path) {
	try {
		const text = await readFile(path, "utf8");
		return text.split("\n").slice(0, -1).map((line) => JSON.parse(line));
	} catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function isolatedPi({ root = tmpdir(), entry, config = {}, signal }) {
	if (process.platform !== "linux") throw new Error("Isolated Pi replay needs Linux, python3, and libseccomp.so.2");
	const work = await mkdtemp(join(root, "pi-"));
	const state = { work, agent: join(work, "agent"), project: join(work, "project"), trace: join(work, "ui.jsonl"), restart: join(work, "restart"),
		guard: join(work, "supervise.py"), extension: join(work, "observe.mjs"), children: new Set(), sockets: new Set() };
	try {
		const dirs = Object.fromEntries(["home", "cache", "data", "config", "run", "tmp", "state", "bin"].map((name) => [name, join(work, name)]));
		await Promise.all([...Object.values(dirs), state.agent, state.project].map((dir) => mkdir(dir, { mode: 0o700 })));
		await Promise.all([symlink(process.execPath, join(dirs.bin, "node")), symlink("/bin/sh", join(dirs.bin, "sh"))]);
		state.env = { PATH: dirs.bin, HOME: dirs.home, TMPDIR: dirs.tmp, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
			XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.run, JITI_FS_CACHE: "0", PI_CODING_AGENT_DIR: state.agent,
			PI_OFFLINE: "1", TERM: "xterm-256color", LANG: "C.UTF-8", SHELL: "/bin/sh", SDL_AUDIODRIVER: "dummy",
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dirs.run, "no-session-bus")}`,
			PULSE_SERVER: `unix:${join(dirs.run, "no-audio-server")}`, PIPEWIRE_RUNTIME_DIR: dirs.run };
		await writeFile(state.guard, supervisor);
		await writeFile(state.extension, `import { appendFileSync, writeFileSync } from 'node:fs';\n${entry ? `import micme from ${JSON.stringify(entry)};` : "const micme = undefined;"}\nconst trace = ${JSON.stringify(state.trace)}; const restart = ${JSON.stringify(state.restart)};\n${instrumentation}`);
		await writeFile(join(state.agent, "settings.json"), JSON.stringify({ quietStartup: true, enableSkillCommands: false }));
		state.configure = (settings) => writeFile(join(state.agent, "micme.json"), JSON.stringify({ ...config, ...settings, MICME_AUTO_DOWNLOAD_MODEL: "0", MICME_AUTO_SUBMIT: "0" }));
		await state.configure({});
		signal?.throwIfAborted();
		return state;
	} catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
}

export function startIsolated(state, argv, { width = 80, interactive = false, direct = false, signal } = {}) {
	signal?.throwIfAborted();
	const child = spawn("/usr/bin/python3", [state.guard, direct ? "exec" : String(width), ...argv], {
		cwd: state.project, env: state.env, stdio: interactive ? "inherit" : "pipe",
	});
	const abort = () => child.kill("SIGTERM");
	const close = new Promise((done) => {
		child.once("error", (error) => done({ code: null, error }));
		child.once("close", (code, signal) => done({ code, signal }));
	}).finally(() => { state.children.delete(handle); signal?.removeEventListener("abort", abort); });
	const handle = { child, close, abort };
	state.children.add(handle);
	child.stdin?.on("error", () => {});
	signal?.addEventListener("abort", abort, { once: true });
	return handle;
}

export function startPi(state, binary, settings) {
	return startIsolated(state, [binary, "--offline", "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-tools", "--no-session", "-e", state.extension], settings);
}

export async function closePi(state) {
	try {
		for (const handle of state.children) handle.abort();
		await Promise.all([...state.children].map((handle) => handle.close));
		for (const socket of state.sockets) socket.destroy();
		if (state.bridge) await new Promise((done) => state.bridge.close(done));
		await state.provider?.close();
	} finally { await rm(state.work, { recursive: true, force: true }); }
}

export async function waitFor(get, signal, problem, budget = 8_000) {
	const limit = performance.now() + budget;
	while (performance.now() <= limit) {
		signal?.throwIfAborted();
		const found = await get();
		if (found) return found;
		await delay(20, undefined, { signal });
	}
	throw new Error(problem);
}

export function recorderCommand(sample, trace) {
	return `exec ${[process.execPath, recorder].map(sh).join(" ")} {audio} ${[sample, trace].map(sh).join(" ")}`;
}

function program(role) { return `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(harness).href + "?seed=" + role)};\n`; }

async function seed(state) {
	const sample = join(state.project, "public-sample.wav");
	const pcm = Buffer.alloc(128_000);
	for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(1_200 * Math.sin(i * Math.PI / 32)), i * 2);
	await writeFile(sample, Buffer.concat([wavHeader(pcm.length), pcm]));
	const worker = join(state.work, "scripted-worker");
	const clip = join(state.work, "scripted-clip");
	const model = join(state.work, "ggml-base.en.bin");
	const vad = join(state.work, "scripted-vad.bin");
	await Promise.all([writeFile(worker, program("worker"), { mode: 0o700 }), writeFile(clip, program("clip"), { mode: 0o700 }),
		writeFile(model, "Public scripted stand-in; not model weights.\n"), writeFile(vad, "Public scripted stand-in; not model weights.\n")]);
	const capture = join(state.work, "capture.jsonl");
	return { sample, capture, settings: { MICME_RECORD_COMMAND: recorderCommand(sample, capture), MICME_LIVE_BIN: worker,
		MICME_WHISPER_CPP_BIN: clip, MICME_WHISPER_CPP_MODEL: model, MICME_VAD_MODEL: vad } };
}

async function fixtureProvider(state, signal) {
	const fixture = new URL("./transfer-local-provider.mjs", import.meta.url);
	let adapter;
	try { adapter = await import(fixture.href); }
	catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND" && error.url === fixture.href) return {}; throw error; }
	return mountLocalProvider(state, await adapter.startLocalProvider(signal));
}

export async function mountLocalProvider(state, provider) {
	state.provider = provider;
	const { base } = provider;
	const hostname = base.hostname === "[::1]" ? "::1" : base.hostname;
	if (base.protocol !== "http:" || !["127.0.0.1", "::1"].includes(hostname) || !base.port || base.username || base.password || base.search || base.hash) {
		throw new Error("The optional fixture provider must return an explicit numeric HTTP loopback port");
	}
	const path = join(state.work, "http.sock");
	state.bridge = createServer((local) => {
		const network = createConnection({ host: hostname, port: Number(base.port) });
		for (const socket of [local, network]) {
			state.sockets.add(socket);
			socket.once("close", () => { state.sockets.delete(socket); local.destroy(); network.destroy(); });
			socket.on("error", () => socket.destroy());
		}
		local.pipe(network).pipe(local);
	}).listen(path);
	await once(state.bridge, "listening");
	const preload = join(state.work, "route.cjs");
	await writeFile(preload, `const net = require('node:net');\nconst connect = net.Socket.prototype.connect;\nnet.Socket.prototype.connect = function (...args) {\n  const [opts, cb] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);\n  if ((opts.host ?? opts.hostname) === ${JSON.stringify(hostname)} && Number(opts.port) === ${Number(base.port)}) return connect.call(this, {path: ${JSON.stringify(path)}}, cb);\n  return connect.apply(this, args);\n};\n`);
	state.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
	return { MICME_POLISH_PROVIDER: "local-openai", MICME_POLISH_ENDPOINT: base.href, MICME_POLISH_MODEL: "public-replay" };
}

export function observedPi(state, binary, width, signal) {
	const handle = startPi(state, binary, { width, signal });
	const frames = [];
	const screen = new Screen(width, (lines) => frames.push({ stamp: performance.now(), lines }));
	let stderr = "";
	handle.child.stdout.setEncoding("utf8").on("data", (data) => screen.write(data));
	handle.child.stderr.setEncoding("utf8").on("data", (data) => { stderr = (stderr + data).slice(-2_000); });
	return { ...handle, frames, send: (bytes) => handle.child.stdin.write(bytes), stderr: () => stderr };
}

export const enterCommand = (pi, command) => pi.send(`\x15${command}\r`);

const promptBorder = /^\s*[─━]{5,}/u;
const scrollAbove = /^\s*[─━]+\s+↑\s+\d+\s+more\s+[─━]+\s*$/u;
const scrollBelow = /^\s*[─━]+\s+↓\s+\d+\s+more\s+[─━]+\s*$/u;
const compact = (s) => s.replace(/\s+/gu, " ").trim();

export function promptOnScreen(lines, text) {
	return matchPrompt(lines, text, false);
}

// Only use this with exact editor readback from an observed write. The PTY can
// corroborate the displayed tail of a scrolled prompt, never its hidden lines.
export function promptReadbackOnScreen(lines, text) {
	return matchPrompt(lines, text, true);
}

function matchPrompt(lines, text, allowTail) {
	const desired = compact(text);
	for (let i = 1; i < lines.length; i++) {
		if (!promptBorder.test(lines[i - 1]) || scrollBelow.test(lines[i - 1])) continue;
		const end = lines.findIndex((line, index) => index > i && promptBorder.test(line));
		if (end <= i || scrollBelow.test(lines[end]) || scrollAbove.test(lines[end])) continue;
		const tail = scrollAbove.test(lines[i - 1]);
		if (tail && !allowTail) continue;
		const rows = lines.slice(i, end).map(compact);
		if (tail) rows.reverse();
		let rest = desired;
		for (const cells of rows) {
			// Pi can soft-wrap mid-word (including CJK). The editor readback
			// preserves the whitespace that terminal padding cannot establish.
			if (tail ? !rest.endsWith(cells) : !rest.startsWith(cells)) { rest = null; break; }
			rest = tail ? rest.slice(0, rest.length - cells.length).trimEnd() : rest.slice(cells.length).trimStart();
		}
		if (tail ? rest && rest !== desired : rest === "") return true;
	}
	return false;
}

async function smoke(state, binary, capture, width, signal) {
	const pi = observedPi(state, binary, width, signal);
	try {
		await waitFor(async () => (await traceRows(state.trace)).some((row) => row.kind === "started"), signal, `Pi did not start: ${pi.stderr()}`);
		pi.send(publicPrefix);
		await waitFor(() => promptOnScreen(pi.frames.at(-1)?.lines ?? [], publicPrefix), signal, "Public prefix was not rendered in the real editor");
		pi.send(alternateM);
		await waitFor(async () => (await traceRows(capture)).some((row) => row.type === "capture-end"), signal, "Scripted sample did not reach the recorder");
		const beforeStop = performance.now();
		const first = pi.frames.find(({ lines }) => lines.some((line) => line.trim() === "Live: Public sample"));
		const draft = width === 40 ? /^Live: ….*isolated Pi replay\.$/u : /^Live: Public sample for the isolated Pi replay\.$/u;
		const later = first && pi.frames.find(({ stamp, lines }) => stamp > first.stamp && lines.some((line) => draft.test(line.trim())));
		const committed = later && pi.frames.find(({ stamp, lines }) => stamp > later.stamp && promptOnScreen(lines, `${publicPrefix} Public sample`));
		if (!committed) throw new Error("Real terminal did not render both provisional versions and the subsequent confirmed prefix before stop");
		pi.send(alternateM);
		const target = `${publicPrefix} ${publicWords}`;
		const reached = await waitFor(() => pi.frames.find(({ stamp, lines }) => stamp >= beforeStop && promptOnScreen(lines, target)), signal, "Stop did not render the confirmed public target");
		enterCommand(pi, "/micme last");
		await waitFor(async () => (await traceRows(state.trace)).some((row) => row.kind === "pasteToEditor" && row.text.trim() === publicWords), signal, "Explicit replay did not paste the public sample");
		let replay = pi.frames.findLast(({ lines }) => promptOnScreen(lines, publicWords));
		const neededRedraw = !replay;
		if (!replay) { pi.send("\x1b[D"); replay = await waitFor(() => pi.frames.findLast(({ lines }) => promptOnScreen(lines, publicWords)), signal, "Replay text never rendered, even after Left Arrow"); }
		const ui = await traceRows(state.trace);
		if (ui.filter((row) => row.kind === "shortcut").length !== 2 || ui.some((row) => row.kind === "send" || row.kind === "blocked-input")) {
			throw new Error("Seeded Pi replay did not observe two real shortcut gestures with no send attempt");
		}
		enterCommand(pi, "Public prompt should be blocked");
		await waitFor(async () => (await traceRows(state.trace)).some(({ kind }) => kind === "blocked-input"), signal, "Pi did not block a plain coding prompt");
		console.log(`Pi ${width} columns [scripted ASR, real PTY]: first pair and advancing draft rendered${width === 40 ? " (clipped)" : ""} before commit; stop-to-target ${Math.round(reached.stamp - beforeStop)} ms; confirmed ${JSON.stringify(target)}; replay ${JSON.stringify(publicWords)}${neededRedraw ? " (after Left Arrow)" : ""}; no sends or queues`);
		enterCommand(pi, width === 40 ? "/transfer-restart" : "/quit");
		const result = await pi.close;
		if (result.code !== 0) throw new Error(`Pi exited with ${result.code ?? "no exit status"}`);
	} catch (error) {
		throw new Error(`${error.message}\n${pi.stderr()}\n${pi.frames.at(-1)?.lines.join("\n") ?? "No PTY output"}`, { cause: error });
	} finally { pi.abort(); await pi.close; }
}

export async function launchPiLocal(manifest) {
	if (manifest !== undefined && !isAbsolute(manifest)) throw new TypeError("Use an absolute transfer manifest path");
	return withInterrupts(async (stop) => {
		const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
		const signal = interactive ? stop : AbortSignal.any([stop, AbortSignal.timeout(45_000)]);
		const native = manifest === undefined ? null : await (await import("./transfer-pi.mjs")).localNativeOptions(manifest);
		if (native && !interactive) throw new Error("Explicit native replay needs an interactive terminal; use --transfer for recorded takes");
		const binary = native?.binary ?? installedPi;
		try { await access(binary, constants.X_OK); } catch { throw new Error("Pi is not installed locally; run npm ci in this checkout before replay"); }
		const entry = native?.entry ?? join(checkout, "src/extension.ts");
		const state = await isolatedPi({ entry, signal });
		try {
			const source = native ? await native.prepare(state) : await seed(state);
			const provider = native ? {} : await fixtureProvider(state, signal);
			await state.configure({ MICME_TRANSCRIPTION_MODE: "stream", MICME_TRANSCRIBE_BACKEND: "whisper.cpp", MICME_LANGUAGE: "en",
				MICME_PROCESS_AUDIO: "0", MICME_VALIDATE_AUDIO: "0", MICME_STREAM_FINALIZE_WITH_CLIP: "0", ...source.settings, ...provider });
			console.log(`Pi replay: ${native ? "explicit local native, paced public WAV" : "scripted ASR with real Pi"}; network blocked except installed loopback fixture, no microphone or coding prompts.`);
			console.log(`Public sample: ${source.sample}\nAlt+M starts/stops; /micme last replays; /transfer-restart relaunches this disposable session; /quit removes it.`);
			if (!interactive) {
				for (const width of [40, 80]) {
					await Promise.all([rm(state.trace, { force: true }), rm(source.capture, { force: true })]);
					await smoke(state, binary, source.capture, width, signal);
					if (width === 40) { await access(state.restart); await rm(state.restart); }
				}
				await access(source.sample);
				console.log("Restarted only the disposable session; public seed survived the restart.");
				return;
			}
			while (!signal.aborted) {
				await rm(state.restart, { force: true });
				const result = await startPi(state, binary, { interactive, signal }).close;
				if (signal.aborted) break;
				if (result.code !== 0) throw new Error(`Isolated Pi could not run (exit ${result.code ?? "unavailable"})`);
				try { await access(state.restart); } catch (error) { if (error.code === "ENOENT") break; throw error; }
			}
		} finally { await closePi(state); }
	});
}

async function scriptedWorker() {
	if (process.argv.includes("--protocol-version")) { console.log("1"); return; }
	const event = (type, fields) => console.log(JSON.stringify({ type, ...fields }));
	event("ready", { version: 1, rate: 16_000, loadMs: 0, asrLoads: 1, vadLoads: 1 });
	let pending = Buffer.alloc(0);
	let through = 0;
	let stage = 0;
	let confirmed = 0;
	for await (const part of process.stdin) {
		pending = Buffer.concat([pending, part]);
		while (pending.length) {
			if (pending[0] === 3) {
				if (through > confirmed) event("final", { from: confirmed, to: through, text: stage >= 3 ? "for the isolated Pi replay." : publicWords });
				event("done", { through, asrCalls: 0, asrMs: 0, vadFrames: 0 });
				return;
			}
			if (pending.length < 5) break;
			const samples = pending.readUInt32LE(1);
			const end = 5 + samples * 2;
			if (pending.length < end) break;
			const preview = pending[0] === 1;
			pending = pending.subarray(end);
			through += samples;
			if (through >= 28_800 && stage < 3) { event("final", { from: 0, to: through, text: "Public sample" }); confirmed = through; stage = 3; }
			else if (preview && through >= 14_400 && stage < 2) { event("partial", { from: 0, to: through, text: publicWords }); stage = 2; }
			else if (preview && through >= 6_400 && stage < 1) { event("partial", { from: 0, to: through, text: "Public sample" }); stage = 1; }
			event("ack", { through });
		}
	}
}

const role = new URL(import.meta.url).searchParams.get("seed");
if (role === "worker") await scriptedWorker();
else if (role === "clip") {
	const output = process.argv.indexOf("-of");
	if (output < 0 || !process.argv[output + 1]) process.exitCode = 2;
	else await writeFile(`${process.argv[output + 1]}.txt`, `${publicWords}\n`);
}
