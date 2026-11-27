#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

const hiddenEnvironmentFilePattern = new RegExp(`^\\.${"env"}(?:$|\\.)`);
const requiredWorkerSources = [
  "native/live/CMakeLists.txt",
  "native/live/main.cpp",
  "native/live/decoder.cpp",
  "native/live/decoder.hpp",
];
const recognizerSources = [
  "native/recognizer/CMakeLists.txt",
  "native/recognizer/instrument.cmake",
  "native/recognizer/main.cpp",
  "native/recognizer/README.md",
];
const appleHelperSource = "native/polish/apple-final.swift";
const allowedNativeFiles = new Set([...requiredWorkerSources, "native/live/README.md", ...recognizerSources, appleHelperSource]);
const publicBins = {
  "micme-doctor": "dist/doctor/scripts/doctor.mjs",
  "micme-transcribe": "dist/doctor/scripts/transcribe.mjs",
};
const piPeers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

const forbiddenChecks = [
  {
    label: "environment files",
    test: (path) => hiddenEnvironmentFilePattern.test(path),
  },
  { label: "project-local pi state", test: (path) => path.startsWith(".pi/") },
  { label: "generated Micme config", test: (path) => path === "micme.json" || path.endsWith("/micme.json") },
  { label: "node_modules", test: (path) => path.startsWith("node_modules/") || path.includes("/node_modules/") },
  { label: "planning specs", test: (path) => path.startsWith("specs/") },
  { label: "test fixtures", test: (path) => /(^|\/)(test|fixtures)\//.test(path) },
  { label: "extension in headless build", test: (path) => path === "dist/doctor/src/extension.js" },
  { label: "unexpected native files", test: (path) => path.startsWith("native/") && !allowedNativeFiles.has(path) },
  { label: "local build products", test: (path) => path.startsWith("build/") || /(^|\/)(micme-live|micme-recognizer|apple-final)(\.exe)?$/i.test(path) },
  { label: "Micme cache", test: (path) => path.startsWith(".micme/") || path.includes("/.micme/") },
  { label: "Micme recordings", test: (path) => path.startsWith("micme-rec/") || path.includes("/micme-rec/") },
  { label: "token insight files", test: (path) => path.includes("token-insights") },
  { label: "npm tarballs", test: (path) => /(^|\/)micme-[^/]+\.tgz$/i.test(path) || path.endsWith(".tgz") },
  { label: "audio artifacts", test: (path) => /\.(wav|mp3|m4a|flac|ogg|opus|aiff?|pcm)$/i.test(path) },
  { label: "model artifacts", test: (path) => /(^|\/)(ggml-.+\.bin|.+\.(gguf|onnx|safetensors|tflite|pt|pth|mlmodel))$/i.test(path) },
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

function checkManifest(manifest) {
  const { name, pi, bin, scripts } = manifest;
  const binTargets = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  // npm's manifest uses slash-separated paths without the leading "./".
  const entrypoints = [...(pi?.extensions ?? []), ...binTargets].map((path) => posix.normalize(path));
  const required = new Set([...entrypoints, ...requiredWorkerSources]);
  const errors = [];
  if (name === "@senad-d/micme") {
    for (const [command, target] of Object.entries(publicBins)) {
      if (typeof bin?.[command] !== "string" || posix.normalize(bin[command]) !== target) errors.push(`${command} must declare ${target}.`);
    }
    for (const source of recognizerSources) required.add(source);
    if (existsSync(appleHelperSource)) required.add(appleHelperSource);
    for (const peer of piPeers) {
      if (Object.hasOwn(manifest.dependencies ?? {}, peer) || Object.hasOwn(manifest.optionalDependencies ?? {}, peer)) {
        errors.push(`${peer} must not be a runtime dependency of the standalone package.`);
      }
      if (Object.hasOwn(manifest.peerDependencies ?? {}, peer) && manifest.peerDependenciesMeta?.[peer]?.optional !== true) {
        errors.push(`${peer} must be an optional peer of the standalone package.`);
      }
    }
    for (const phase of ["preinstall", "install", "postinstall"]) {
      if (Object.hasOwn(scripts ?? {}, phase)) errors.push(`Unexpected install lifecycle hook: ${phase}.`);
    }
  }
  return { required, errors };
}

const { required, errors } = checkManifest(JSON.parse(readFileSync("package.json", "utf8")));
const files = readPackFiles();
const packedPaths = new Set(files);
const missing = [...required].filter((path) => !packedPaths.has(path));
const violations = [];
for (const file of files) {
  for (const check of forbiddenChecks) {
    if (check.test(file)) violations.push({ file, label: check.label });
  }
}

console.log(`Micme package dry-run contains ${files.length} file(s).`);
for (const file of files) console.log(`- ${file}`);

if (errors.length > 0) {
  console.error("\nInvalid package manifest:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

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
