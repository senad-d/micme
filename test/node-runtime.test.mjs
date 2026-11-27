import assert from "node:assert/strict";
import test from "node:test";
import { getWindowsNodeExecutable } from "../src/node-runtime.ts";

// Inert Windows paths; no files are created, opened or executed.
const programFiles = String.raw`D:\Program Files`;
const standardNode = String.raw`D:\Program Files\nodejs\node.exe`;
const bunHost = { execPath: String.raw`C:\Apps\omp.exe`, versions: { bun: "1.4.4" } };

function unexpectedProbe() {
	assert.fail("Node resolution must not probe this path");
}

function regularFile() {
	return { isFile: () => true };
}

function getProgramFiles() {
	return programFiles;
}

test("the Windows helper reuses the Node host's interpreter without lookup", () => {
	const host = { execPath: standardNode, versions: {} };
	assert.equal(getWindowsNodeExecutable(unexpectedProbe, host, unexpectedProbe, unexpectedProbe), standardNode);
});

test("the Windows Bun helper selects the absolute, regular Node executable in the system's Program Files", () => {
	const realpath = (file) => {
		assert.equal(file, standardNode);
		return file;
	};
	assert.equal(getWindowsNodeExecutable(getProgramFiles, bunHost, realpath, regularFile), standardNode);
});

test("the Windows Bun helper fails clearly if the system directory is not drive-qualified", (t) => {
	const probe = t.mock.fn(unexpectedProbe);
	assert.throws(() => getWindowsNodeExecutable(() => "Program Files", bunHost, probe, probe), /Install Node\.js .*Program Files/);
	assert.equal(probe.mock.callCount(), 0);
});

test("the Windows Bun helper rejects a resolved path outside the machine-wide installation", () => {
	const realpath = () => String.raw`C:\Other\node.exe`;
	assert.throws(() => getWindowsNodeExecutable(getProgramFiles, bunHost, realpath, regularFile), /trusted Node\.js interpreter/);
});

test("the Windows Bun helper fails clearly instead of falling back when the interpreter is absent", () => {
	const error = Object.assign(new Error("not found"), { code: "ENOENT" });
	const realpath = () => { throw error; };
	assert.throws(() => getWindowsNodeExecutable(getProgramFiles, bunHost, realpath, unexpectedProbe), { message: /Install Node\.js .*Program Files/, cause: error });
});

test("the Windows Bun helper requires a regular file at the expected path", () => {
	assert.throws(() => getWindowsNodeExecutable(getProgramFiles, bunHost, (file) => file, () => ({ isFile: () => false })), /trusted Node\.js interpreter/);
});
