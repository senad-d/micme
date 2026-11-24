import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";
import { parse } from "yaml";

let comparisonRule;
before(async () => {
	const workflow = parse(await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"));
	// Inspect the release jobs without executing checkout or delivery.
	const { validate, publish } = workflow.jobs;
	assert.ok(validate && publish, "missing validate or publish job");
	assert.deepEqual(validate.permissions, { contents: "read" }, "validation must have read-only access");
	assert.ok(!Object.hasOwn(validate, "continue-on-error"), "validation failure must not be ignored");
	assert.ok([publish.needs].flat().includes("validate"), "publish must depend on validate");
	assert.ok(!Object.hasOwn(publish, "if"), "publish must keep the default success condition for its dependencies");

	const [guard, ...laterSteps] = validate.steps;
	assert.equal(guard?.name, "Verify default branch", "the guard must be the first validate step");
	assert.ok(!Object.hasOwn(guard, "if") && !Object.hasOwn(guard, "continue-on-error"),
		"the guard must run and block checkout on failure");
	const checkout = laterSteps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
	assert.ok(checkout, "validation must check out the repository after the guard");
	assert.ok(!Object.hasOwn(checkout, "if"), "checkout must keep the default success condition");

	// Check the Actions bindings before supplying their resolved values to the comparison.
	assert.equal(guard.env?.EXPECTED_REF, "refs/heads/${{ github.event.repository.default_branch }}");
	assert.equal(guard.env?.CURRENT_REF, "${{ github.ref }}");
	const script = guard.run?.trimEnd();
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
