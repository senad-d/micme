import { realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";

// A Bun-compiled host's execPath points at the agent, not a JS interpreter.
export const posixNodeExecutable = process.versions.bun ? "node" : process.execPath;

export function getWindowsNodeExecutable(
	getProgramFiles: () => string | undefined,
	host: Pick<NodeJS.Process, "execPath" | "versions"> = process,
	realpath = realpathSync.native,
	stat = statSync,
) {
	if (!host.versions.bun) return host.execPath;

	let cause: unknown;
	try {
		// Only use the machine-wide installation folder reported by Windows.
		// Bun can load project environment files, so do not use ProgramFiles or PATH from the environment.
		const root = getProgramFiles();
		if (root && /^[a-z]:[\\/]/i.test(root)) {
			const candidate = win32.join(root, "nodejs", "node.exe");
			const physical = realpath(candidate);
			// Reject symlinks and junctions that resolve outside the expected path.
			if (physical.toLowerCase() === candidate.toLowerCase() && stat(physical).isFile()) return physical;
		}
	} catch (error) {
		cause = error;
	}

	throw new Error("Micme could not locate a trusted Node.js interpreter. Install Node.js 22.19 or newer in the standard Windows Program Files\\nodejs directory.", { cause });
}
