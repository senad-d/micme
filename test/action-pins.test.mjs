import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkerPath = fileURLToPath(new URL("../scripts/ci/check-action-pins.mjs", import.meta.url));
const workflowDirectory = join(".github", "workflows");
const fullSha = "0123456789abcdef0123456789abcdef01234567";

async function runPinCheck(t, filename, workflow) {
	const root = await mkdtemp(join(tmpdir(), "micme-action-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, workflowDirectory), { recursive: true });
	await writeFile(join(root, workflowDirectory, filename), workflow);
	const result = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: "utf8", timeout: 5_000 });
	assert.ifError(result.error);
	return result;
}

test("action pin check accepts full SHAs and local uses in a workflow", async (t) => {
	const result = await runPinCheck(t, "valid.yml", `name: Valid references
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: Example/action@${fullSha}
      - uses: 'Example/repo/sub-action@${fullSha.toUpperCase()}' # Pinned subdirectory action
      - uses: ./.github/actions/local
      - run: |
          echo 'uses: Example/action@v1'
  remote:
    uses: Example/repo/.github/workflows/reusable.yml@${fullSha}
  local:
    uses: ./.github/workflows/reusable.yml
`);
	assert.equal(result.status, 0, result.stderr);
});

test("action pin check reports every unpinned action and reusable workflow", async (t) => {
	const badActionRefs = [
		"Example/action@v1",
		`Example/action@${fullSha.slice(1)}`,
		`Example/action@${fullSha}8`,
		`Example/action@${fullSha.slice(1)}g`,
	];
	const badWorkflowRef = "Example/repo/.github/workflows/reusable.yml@main";
	const result = await runPinCheck(t, "invalid.yaml", `name: Invalid references
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${badActionRefs.map((ref) => `      - uses: ${ref}`).join("\n")}
  remote:
    uses: ${badWorkflowRef}
`);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.ok(result.stderr.includes(join(workflowDirectory, "invalid.yaml")), result.stderr);
	for (const ref of [...badActionRefs, badWorkflowRef]) {
		assert.ok(result.stderr.includes(`"${ref}"`), `missing diagnostic for ${ref}:\n${result.stderr}`);
	}
});
