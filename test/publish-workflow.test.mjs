import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

let comparisonRule;
before(async () => {
	const workflow = (await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
	// Extract only the first step's literal script; never execute checkout or any release step.
	const publish = workflow.match(/^ {2}publish:\n((?: {4}[^\n]*\n|\n)+)/m)?.[1];
	assert.ok(publish, "missing publish job");
	const guard = publish.match(/^ {4}steps:\n {6}- name: Verify default branch\n([\s\S]*?)(?=^ {6}- )/m)?.[1];
	assert.ok(guard, "the guard must be the first publish step");
	assert.match(publish, /^ {6}- name: Check out repository\n {8}uses: actions\/checkout@/m);
	assert.doesNotMatch(guard, /^ {8}(?:if|continue-on-error):/m, "the guard must run and block checkout on failure");
	// Check the Actions bindings before supplying their resolved values to the comparison.
	assert.match(guard, /^ {10}EXPECTED_REF: refs\/heads\/\$\{\{ github\.event\.repository\.default_branch \}\}$/m);
	assert.match(guard, /^ {10}CURRENT_REF: \$\{\{ github\.ref \}\}$/m);
	const script = guard.match(/^ {8}run: \|\n((?: {10}[^\n]*\n|\n)+)/m)?.[1].replace(/^ {10}/gm, "").trimEnd();
	// Validate the shell control flow and evaluate its actual POSIX string test without running workflow text as commands.
	const condition = script?.match(/^if \[ "\$CURRENT_REF" (!?=) "\$EXPECTED_REF" \]; then\n(?: {2}echo "[^"\n]*"\n)* {2}exit ([1-9]\d*)\nfi$/);
	assert.ok(condition, "the guard must exit nonzero in the branch controlled by the full-ref comparison");
	comparisonRule = condition;
});

for (const [ref, status] of [
	["refs/heads/main", 0],
	["refs/tags/main", 1],
	["refs/heads/feature", 1],
	["refs/heads/Main", 1],
]) {
	test(`publish guard ${status === 0 ? "allows" : "rejects"} ${ref}`, (t) => {
		// Run the structural checks in before() even when the POSIX comparisons are skipped.
		if (process.platform === "win32") {
			t.skip("POSIX test utility is required");
			return;
		}
		const [, operator, exitOnMatch] = comparisonRule;
		const comparison = spawnSync("test", [ref, operator, "refs/heads/main"], { encoding: "utf8", timeout: 5_000 });
		assert.ifError(comparison.error);
		assert.ok(comparison.status === 0 || comparison.status === 1, comparison.stderr || "the ref comparison must complete");
		assert.equal(comparison.status === 0 ? Number(exitOnMatch) : 0, status);
	});
}
