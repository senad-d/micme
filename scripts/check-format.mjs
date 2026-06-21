#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const checkExtensions = new Set([".ts", ".mjs", ".json", ".md", ".yml", ".yaml"]);
const roots = ["src", "test", "scripts"];
const rootFiles = [
  ".github/workflows/ci.yml",
  ".gitignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "micme.example.json",
  "micme.schema.json",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
];

function extensionOf(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
      continue;
    }

    if (entry.isFile() && checkExtensions.has(extensionOf(path))) {
      files.push(path);
    }
  }

  return files;
}

async function checkFile(path) {
  const text = await readFile(path, "utf8");
  const failures = [];

  if (text.includes("\r")) failures.push("uses CRLF or bare CR line endings");
  if (text.length > 0 && !text.endsWith("\n")) failures.push("does not end with a newline");

  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) failures.push(`line ${index + 1} has trailing whitespace`);
  });

  if (extensionOf(path) === ".json") {
    try {
      JSON.parse(text);
    } catch (error) {
      failures.push(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return failures;
}

const files = [...rootFiles];
for (const root of roots) files.push(...(await collectFiles(root)));
files.sort((a, b) => a.localeCompare(b));

const failures = [];
for (const file of files) {
  try {
    const fileFailures = await checkFile(file);
    for (const failure of fileFailures) failures.push(`${file}: ${failure}`);
  } catch (error) {
    failures.push(`${file}: could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error("Formatting check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Formatting check passed for ${files.length} file(s).`);
}
