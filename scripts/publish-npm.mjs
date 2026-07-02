#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const packageJsonUrl = new URL("package.json", rootUrl);
const pkg = JSON.parse(readFileSync(packageJsonUrl, "utf8"));

const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";
const SAFE_ENV = { ...process.env, PATH: SAFE_PATH };
const COMMAND_PATHS = {
  git: ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"],
  npm: ["/usr/bin/npm", "/usr/local/bin/npm", "/opt/homebrew/bin/npm"],
};
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/;
const SEMVER_IDENTIFIER_RE = "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_RE = new RegExp(
  `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${SEMVER_IDENTIFIER_RE}(?:\\.${SEMVER_IDENTIFIER_RE})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);
const GIT_REF_FORBIDDEN_RE = /[\x00-\x20\x7f~^:?*[\\]/;
const CONTROL_OR_WHITESPACE_RE = /[\x00-\x20\x7f]/;

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function firstExistingPath(paths) {
  return paths.find((path) => existsSync(path));
}

function commandPath(command) {
  const candidates = COMMAND_PATHS[command];
  if (!candidates) fail(`Unsupported command: ${command}`);

  const resolved = firstExistingPath(candidates);
  if (!resolved) fail(`Required command ${command} was not found in trusted locations.`);
  return resolved;
}

function commandDisplayName(command) {
  if (!COMMAND_PATHS[command]) fail(`Unsupported command: ${command}`);
  return command;
}

function assertSafeCommandArgs(args) {
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      fail("Refusing to execute a command with an invalid argument.");
    }
  }
}

function spawnKnownCommand(command, args, options = {}) {
  assertSafeCommandArgs(args);
  return spawnSync(commandPath(command), args, {
    cwd: root,
    env: SAFE_ENV,
    ...options,
  });
}

function capture(command, args, options = {}) {
  assertSafeCommandArgs(args);
  return execFileSync(commandPath(command), args, {
    cwd: root,
    env: SAFE_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function run(command, args) {
  console.log(`\n$ ${commandDisplayName(command)} ${args.join(" ")}`);
  const result = spawnKnownCommand(command, args, { stdio: "inherit" });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandSucceeds(command, args) {
  const result = spawnKnownCommand(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function assertNonEmptySafeValue(label, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must not be empty.`);
  if (value.startsWith("-")) fail(`${label} must not start with a dash.`);
  if (CONTROL_OR_WHITESPACE_RE.test(value)) fail(`${label} must not contain whitespace or control characters.`);
}

function assertPackageName(value) {
  assertNonEmptySafeValue("Package name", value);
  if (!PACKAGE_NAME_RE.test(value)) fail(`Package name ${value} is not safe for publishing.`);
}

function assertVersion(value) {
  assertNonEmptySafeValue("Version", value);
  if (!SEMVER_RE.test(value)) {
    fail("Enter a valid semver version, for example 0.1.1 or 1.0.0-beta.1.");
  }
}

function assertSafeGitRefSegment(label, value) {
  assertNonEmptySafeValue(label, value);
  if (GIT_REF_FORBIDDEN_RE.test(value)) fail(`${label} contains characters that are not safe in git refs.`);
  if (value.includes("..") || value.includes("@{") || value.includes("//")) fail(`${label} is not a safe git ref.`);
  if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) fail(`${label} is not a safe git ref.`);
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} is not a safe git ref.`);
  }
}

function gitTagForVersion(version) {
  assertVersion(version);
  const tag = `v${version}`;
  assertSafeGitRefSegment("Git tag", tag);
  return tag;
}

function npmPackageSpec(packageName, version) {
  assertPackageName(packageName);
  assertVersion(version);
  const spec = `${packageName}@${version}`;
  assertNonEmptySafeValue("npm package spec", spec);
  return spec;
}

function validateCurrentBranch(branch) {
  assertSafeGitRefSegment("Current branch", branch);
  if (branch === "HEAD" || branch.startsWith("HEAD:")) fail("Git is in detached HEAD.");
  return branch;
}

function ensureCleanGitTree() {
  const status = capture("git", ["status", "--porcelain"]);
  if (status) {
    fail("Working tree is not clean. Commit or stash changes before publishing.");
  }
}

function ensureNpmLogin() {
  const result = spawnKnownCommand("npm", ["whoami"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    fail("npm login is required before publishing. Run `npm login`, then retry.");
  }

  const npmUser = String(result.stdout).trim();
  assertNonEmptySafeValue("npm username", npmUser);
  console.log(`npm user: ${npmUser}`);
}

function packageIsScoped(packageName) {
  assertPackageName(packageName);
  return packageName.startsWith("@");
}

function publishArgsForPackage(packageName) {
  const publishArgs = ["publish"];
  if (packageIsScoped(packageName)) publishArgs.push("--access", "public");
  return publishArgs;
}

function packageVersionExists(packageName, version) {
  const spec = npmPackageSpec(packageName, version);
  const publishedVersion = spawnKnownCommand("npm", ["view", spec, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return publishedVersion.status === 0 && String(publishedVersion.stdout).trim().length > 0;
}

async function askQuestion(question) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function readVersionFromUser() {
  const version = await askQuestion("Version to publish (for example 0.1.1): ");
  assertVersion(version);
  return version;
}

async function confirmPublishPlan(version, gitTag, publishArgs) {
  console.log("\nThis will:");
  console.log("- run npm validation");
  console.log(`- run npm version ${version} to update package.json/package-lock.json`);
  console.log(`- create a release commit and git tag ${gitTag}`);
  console.log(`- run npm ${publishArgs.join(" ")}`);

  const confirm = (await askQuestion("Continue? [y/N] ")).toLowerCase();
  if (confirm !== "y" && confirm !== "yes") fail("Publish cancelled.");
}

async function pushReleaseRefs(gitTag) {
  const push = (await askQuestion(`Push current branch and ${gitTag} to origin? [y/N] `)).toLowerCase();
  if (push !== "y" && push !== "yes") return;

  const branch = validateCurrentBranch(capture("git", ["branch", "--show-current"]));
  run("git", ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
  run("git", ["push", "origin", `refs/tags/${gitTag}:refs/tags/${gitTag}`]);
}

async function main() {
  assertPackageName(pkg.name);
  assertVersion(pkg.version);

  console.log(`Publishing ${pkg.name}`);
  console.log(`Current version: ${pkg.version}`);

  ensureCleanGitTree();
  ensureNpmLogin();

  const version = await readVersionFromUser();
  if (version === pkg.version) fail(`package.json is already at version ${version}. Choose a new version.`);

  const gitTag = gitTagForVersion(version);
  if (commandSucceeds("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${gitTag}`])) {
    fail(`Git tag ${gitTag} already exists.`);
  }

  if (packageVersionExists(pkg.name, version)) fail(`${pkg.name}@${version} already exists on npm.`);

  const publishArgs = publishArgsForPackage(pkg.name);
  await confirmPublishPlan(version, gitTag, publishArgs);

  run("npm", ["run", "validate"]);
  run("npm", ["version", version, "-m", "chore(release): v%s"]);
  run("npm", publishArgs);
  await pushReleaseRefs(gitTag);

  console.log(`\nPublished ${pkg.name}@${version}.`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
