import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

// Byte-for-byte pass-through of the native worker protocol. The overload case only
// delays the first write; no recognition result, frame or acknowledgment is invented.
export async function forwardWorker(binary, trace, slow) {
	const args = process.argv.slice(2);
	if (args[0] === "--protocol-version") {
		process.stdout.write(execFileSync(binary, args));
		return;
	}
	const log = (type, fields = {}) => appendFileSync(trace, `${JSON.stringify({ type, t: Number(process.hrtime.bigint()) / 1e6, ...fields })}\n`);
	const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
	log("worker-spawn", { argv: args });
	const hash = createHash("sha256");
	let fed = 0;
	let input = Buffer.alloc(0);
	let output = "";
	const decode = new StringDecoder("utf8");
	let first = true;
	const incoming = new Transform({
		transform(chunk, _encoding, cb) {
			if (slow && first) {
				first = false;
				void delay(2_400).then(() => observeInput(chunk, cb));
			} else observeInput(chunk, cb);
		},
	});
	const outgoing = new Transform({
		transform(chunk, _encoding, cb) {
			output += decode.write(chunk);
			let end;
			while ((end = output.indexOf("\n")) !== -1) {
				const raw = output.slice(0, end);
				try {
					log("event", { event: JSON.parse(raw) });
				} catch {
					log("invalid-event", { raw });
				}
				output = output.slice(end + 1);
			}
			cb(null, chunk);
		},
	});
	const exited = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code, signal }));
	});
	child.stdin.on("error", (error) => log("input-error", { error: error.message }));
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk).slice(-12_000);
		process.stderr.write(chunk);
	});
	let peakRssKiB = 0;
	const rss = process.platform === "linux" ? setInterval(() => {
		try {
			const contents = readFileSync(`/proc/${child.pid}/status`, "utf8");
			peakRssKiB = Math.max(peakRssKiB, Number(contents.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0));
		} catch { /* the process can exit between samples */ }
	}, 100) : undefined;
	process.stdin.pipe(incoming).pipe(child.stdin);
	child.stdout.pipe(outgoing).pipe(process.stdout, { end: false });
	const result = await exited.finally(() => clearInterval(rss));
	log("worker-exit", { ...result, peakRssKiB: peakRssKiB || null, stderr });
	process.stdin.pause();
	process.exitCode = result.code ?? 1;

	function observeInput(chunk, cb) {
		input = Buffer.concat([input, chunk]);
		while (input.length) {
			const op = input[0];
			if (op === 3) {
				log("finish", { fed, sha256: hash.digest("hex") });
				input = input.subarray(1);
				continue;
			}
			if (input.length < 5) break;
			const samples = input.readUInt32LE(1);
			const end = 5 + samples * 2;
			if (input.length < end) break;
			hash.update(input.subarray(5, end));
			fed += samples;
			log("feed", { op, samples, through: fed });
			input = input.subarray(end);
		}
		cb(null, chunk);
	}
}
