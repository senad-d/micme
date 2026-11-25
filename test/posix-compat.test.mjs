import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { constants, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PosixDirectory, posixFileIdentity } from "../src/posix-directory.ts";
import { raceWithTimeout, runProcess } from "../src/processes.ts";

const posixOnly = { skip: process.platform === "win32" };
const node = process.execPath;

async function mockCompiledHost(t) {
	const root = await mkdtemp(join(tmpdir(), "micme-compiled-host-"));
	const path = process.env.PATH;
	const execPath = process.execPath;
	Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.5" });
	process.execPath = join(root, "not-a-node-executable");
	process.env.PATH = root;
	t.after(async () => {
		delete process.versions.bun;
		process.execPath = execPath;
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

test("POSIX helpers under compiled Bun report the Node.js prerequisite when node is absent", posixOnly, async (t) => {
	await mockCompiledHost(t);
	await assert.rejects(runProcess(node, ["-v"], 2_000), /Node\.js 22\.19\.0 or newer.*PATH/);
});

test("POSIX helpers under compiled Bun use Node on PATH with a held directory descriptor", posixOnly, async (t) => {
	const root = await mockCompiledHost(t);
	await symlink(node, join(root, "node"));
	const spool = join(root, "spool");
	const original = join(root, "original");
	await mkdir(spool);
	const dir = new PosixDirectory(openSync(spool, constants.O_RDONLY | constants.O_DIRECTORY), false);
	try {
		await rename(spool, original);
		await mkdir(spool);
		const sentinel = join(spool, "raw.wav");
		await writeFile(sentinel, "replacement");

		const result = await runProcess(node, ["-e", "require('node:fs').writeFileSync('raw.wav', 'capture')"], 2_000, { cwdFd: dir.fd });
		assert.equal(result.code, 0, result.stderr);
		const originalFile = join(original, "raw.wav");
		assert.equal(await readFile(originalFile, "utf8"), "capture");
		assert.equal(await dir.containsFile(posixFileIdentity(await stat(originalFile, { bigint: true }))), true);
		await dir.clear();
		await assert.rejects(readFile(originalFile), { code: "ENOENT" });
		assert.equal(await readFile(sentinel, "utf8"), "replacement");
	} finally {
		dir.close();
	}
});

test("POSIX hook exit and output settle when IPC lacks channel.unref", posixOnly, async (t) => {
	const spawn = childProcess.spawn;
	let launcher;
	const mock = t.mock.method(childProcess, "spawn", (_command, args, options) => {
		launcher = spawn(process.execPath, args, options);
		// Keep the real IPC transport; Bun's Channel lacks this Node method.
		launcher.channel.unref = undefined;
		return launcher;
	});
	syncBuiltinESMExports();
	t.after(() => {
		mock.mock.restore();
		syncBuiltinESMExports();
		if (launcher?.connected) launcher.disconnect();
	});

	const result = await raceWithTimeout(runProcess(node, ["-e", "console.log('stdout'); process.exitCode = 23"], 1_500), 3_000);
	assert.equal(result?.code, 23);
	assert.equal(result.stdout, "stdout\n");
});
