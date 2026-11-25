#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

const hiddenEnvironmentFilePattern = new RegExp(`^\\.${"env"}(?:$|\\.)`);
const requiredWorkerSources = [
  "native/live/CMakeLists.txt",
  "native/live/main.cpp",
  "native/live/decoder.cpp",
  "native/live/decoder.hpp",
];
const allowedNativeFiles = new Set([...requiredWorkerSources, "native/live/README.md"]);

const forbiddenChecks = [
  {
    label: "environment files",
    test: (path) => hiddenEnvironmentFilePattern.test(path),
  },
  { label: "project-local pi state", test: (path) => path.startsWith(".pi/") },
  { label: "generated Micme config", test: (path) => path === "micme.json" || path.endsWith("/micme.json") },
  { label: "node_modules", test: (path) => path.startsWith("node_modules/") || path.includes("/node_modules/") },
  { label: "planning specs", test: (path) => path.startsWith("specs/") },
  { label: "unexpected native files", test: (path) => path.startsWith("native/") && !allowedNativeFiles.has(path) },
  { label: "local build products", test: (path) => path.startsWith("build/") || /(^|\/)micme-live(\.exe)?$/i.test(path) },
  { label: "Micme cache", test: (path) => path.startsWith(".micme/") || path.includes("/.micme/") },
  { label: "Micme recordings", test: (path) => path.startsWith("micme-rec/") || path.includes("/micme-rec/") },
  { label: "token insight files", test: (path) => path.includes("token-insights") },
  { label: "npm tarballs", test: (path) => /(^|\/)micme-[^/]+\.tgz$/i.test(path) || path.endsWith(".tgz") },
  { label: "audio artifacts", test: (path) => /\.(wav|mp3|m4a|flac|ogg|opus|aiff?|pcm)$/i.test(path) },
  { label: "model artifacts", test: (path) => /(^|\/)(ggml-.+\.(bin|gguf)|.+\.gguf)$/i.test(path) },
];

function readPackFiles() {
  // npm run supplies the CLI path, so Windows does not need to launch npm.cmd.
  const npmCli = process.env.npm_execpath;
  if (!npmCli && process.platform === "win32") {
    throw new Error("Run this check with npm run check:pack.");
  }
  const packArgs = ["pack", "--dry-run", "--json"];
  const output = execFileSync(npmCli ? process.execPath : "npm", npmCli ? ["--", npmCli, ...packArgs] : packArgs, {
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

function readRequiredPaths() {
  const { pi, bin } = JSON.parse(readFileSync("package.json", "utf8"));
  const binTargets = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  // npm's manifest uses slash-separated paths without the leading "./".
  const entrypoints = [...(pi?.extensions ?? []), ...binTargets].map((path) => posix.normalize(path));
  return new Set([...entrypoints, ...requiredWorkerSources]);
}

const files = readPackFiles();
const packedPaths = new Set(files);
const missing = [...readRequiredPaths()].filter((path) => !packedPaths.has(path));
const violations = [];
for (const file of files) {
  for (const check of forbiddenChecks) {
    if (check.test(file)) violations.push({ file, label: check.label });
  }
}

console.log(`Micme package dry-run contains ${files.length} file(s).`);
for (const file of files) console.log(`- ${file}`);

if (missing.length > 0) {
  console.error("\nMissing required package paths:");
  for (const path of missing) console.error(`- ${path}`);
  process.exitCode = 1;
}

if (violations.length > 0) {
  console.error("\nForbidden package contents detected:");
  for (const violation of violations) {
    console.error(`- ${violation.file} (${violation.label})`);
  }
  process.exitCode = 1;
}
