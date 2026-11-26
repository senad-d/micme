// A Bun-compiled host's execPath points at the agent, not a JS interpreter.
export const nodeExecutable = process.versions.bun ? "node" : process.execPath;
