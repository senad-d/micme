import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const NODE_PROBE = `
const [major, minor] = process.versions.node.split(".").map(Number);
if (!process.versions.bun && process.release.name === "node" && (major > 22 || (major === 22 && minor >= 19))) {
	process.stdout.write(process.execPath);
}
`;
let nodeExecutable: string | undefined;

export function posixNodeExecutable() {
	// On Pi this is already Node. In a compiled Bun host such as OMP it is
	// the host binary, which cannot run a Node helper script.
	if (!process.versions.bun) return process.execPath;
	if (nodeExecutable) return nodeExecutable;

	const probe = spawnSync("node", ["--input-type=commonjs", "-e", NODE_PROBE], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, killSignal: "SIGKILL",
	});
	if (probe.status !== 0 || !probe.stdout || !isAbsolute(probe.stdout)) {
		throw new Error("Micme's POSIX subprocesses need Node.js 22.19.0 or newer. Install Node.js and put its node executable on PATH before launching OMP.");
	}
	return nodeExecutable = probe.stdout;
}
