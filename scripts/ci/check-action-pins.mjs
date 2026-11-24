import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const workflowDirectory = ".github/workflows";
const pinnedReference = /^[\w.-]+[\\/][\w.-]+(?:[\\/][^@\r\n]+)?@[0-9a-f]{40}$/i;

function isLocalReference(ref) {
  return ref.startsWith("./") || ref.startsWith(".\\") || ref.startsWith("$/");
}

function checkUses(parent, location, failures) {
  if (!Object.hasOwn(parent, "uses")) return;

  const ref = parent.uses;
  if (typeof ref === "string" && (isLocalReference(ref) || pinnedReference.test(ref))) return;

  failures.push(`${location}.uses: ${JSON.stringify(ref)} must be pinned to a full 40-hex commit SHA`);
}

function checkWorkflow(path, failures) {
  try {
    const workflow = parse(readFileSync(path, "utf8"));
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const location = `${path}: jobs.${id}`;
      checkUses(job, location, failures);
      for (const [index, step] of (job.steps ?? []).entries()) {
        checkUses(step, `${location}.steps[${index}]`, failures);
      }
    }
  } catch (error) {
    failures.push(`${path}: could not check workflow: ${error.message}`);
  }
}

const workflows = readdirSync(workflowDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const failures = [];
if (workflows.length === 0) failures.push(`${workflowDirectory}: no workflow files found`);
for (const workflow of workflows) checkWorkflow(join(workflowDirectory, workflow), failures);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Action pin check passed for ${workflows.length} workflow(s).`);
}
