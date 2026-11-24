import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../.github/workflows/stale.yml", import.meta.url), "utf8"));
const staleJob = workflow.jobs["stale-prs"];

// Check the token scope and action inputs without contacting GitHub or changing any PRs.
test("stale workflow grants only pull-requests write access", () => {
	const permissions = { "pull-requests": "write" };
	assert.deepEqual(workflow.permissions, permissions);
	assert.deepEqual(staleJob.permissions ?? workflow.permissions, permissions);
});

test("stale action labels and closes inactive PRs without staling or closing issues", () => {
	const action = staleJob.steps.find(({ uses }) => uses?.startsWith("actions/stale@"));
	assert.ok(action, "missing actions/stale step");
	const inputs = action.with;
	assert.equal(inputs["days-before-issue-stale"], -1);
	assert.equal(inputs["days-before-issue-close"], -1);
	assert.ok(Number.isInteger(inputs["days-before-pr-stale"]) && inputs["days-before-pr-stale"] >= 0);
	assert.ok(Number.isInteger(inputs["days-before-pr-close"]) && inputs["days-before-pr-close"] >= 0);
	assert.ok(inputs["stale-pr-label"]?.trim(), "stale PR labeling must be configured");
	assert.notEqual(String(inputs["debug-only"]).toLowerCase(), "true", "the action must not run in dry-run mode");
});
