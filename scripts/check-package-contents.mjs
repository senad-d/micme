#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const hiddenEnvironmentFilePattern = new RegExp(`^\\.${"env"}(?:$|\\.)`);

const forbiddenChecks = [
  {
    label: "environment files",
    test: (path) => hiddenEnvironmentFilePattern.test(path),
  },
  { label: "project-local pi state", test: (path) => path.startsWith(".pi/") },
  { label: "generated Micme config", test: (path) => path === "micme.json" || path.endsWith("/micme.json") },
  { label: "node_modules", test: (path) => path.startsWith("node_modules/") || path.includes("/node_modules/") },
  { label: "planning specs", test: (path) => path.startsWith("specs/") },
  { label: "Micme cache", test: (path) => path.startsWith(".micme/") || path.includes("/.micme/") },
  { label: "token insight files", test: (path) => path.includes("token-insights") },
  { label: "npm tarballs", test: (path) => /(^|\/)micme-[^/]+\.tgz$/i.test(path) || path.endsWith(".tgz") },
  { label: "audio artifacts", test: (path) => /\.(wav|mp3|m4a|flac|ogg|opus|aiff?|pcm)$/i.test(path) },
  { label: "model artifacts", test: (path) => /(^|\/)(ggml-.+\.(bin|gguf)|.+\.gguf)$/i.test(path) },
];

function readPackFiles() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npmCommand, ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!pack || !Array.isArray(pack.files)) {
    throw new Error("Unexpected npm pack --dry-run --json output.");
  }
  return pack.files.map((file) => file.path).sort((a, b) => a.localeCompare(b));
}

const files = readPackFiles();
const violations = [];
for (const file of files) {
  for (const check of forbiddenChecks) {
    if (check.test(file)) violations.push({ file, label: check.label });
  }
}

console.log(`Micme package dry-run contains ${files.length} file(s).`);
for (const file of files) console.log(`- ${file}`);

if (violations.length > 0) {
  console.error("\nForbidden package contents detected:");
  for (const violation of violations) {
    console.error(`- ${violation.file} (${violation.label})`);
  }
  process.exitCode = 1;
}
