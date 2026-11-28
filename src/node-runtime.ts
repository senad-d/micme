import { realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

/** Direct-entry fallback for Node versions without import.meta.main. */
export function isDirectInvocation(moduleUrl: string) {
	const entry = process.argv[1];
	// In eval/print mode argv[1] can be an argument to the evaluated code.
	if (!entry || process.execArgv.some((arg) => /^(?:-(?:e|p|ep|pe)$|--(?:eval|print)(?:=|$))/.test(arg))) return false;
	try {
		// Node resolves an npm bin symlink for import.meta.url but not for argv[1].
		return pathToFileURL(entry).href === moduleUrl || pathToFileURL(realpathSync(entry)).href === moduleUrl;
	} catch {
		return false;
	}
}

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
