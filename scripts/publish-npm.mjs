#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const packageJsonUrl = new URL("package.json", rootUrl);
const pkg = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "ignore",
  });
  return result.status === 0;
}

function ensureCleanGitTree() {
  const status = capture("git", ["status", "--porcelain"]);
  if (status) {
    fail("Working tree is not clean. Commit or stash changes before publishing.");
  }
}

function ensureNpmLogin() {
  const result = spawnSync("npm", ["whoami"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    fail("npm login is required before publishing. Run `npm login`, then retry.");
  }

  console.log(`npm user: ${result.stdout.trim()}`);
}

async function main() {
  console.log(`Publishing ${pkg.name}`);
  console.log(`Current version: ${pkg.version}`);

  ensureCleanGitTree();
  ensureNpmLogin();

  const rl = createInterface({ input, output });
  const version = (await rl.question("Version to publish (for example 0.1.1): ")).trim();

  if (!semverPattern.test(version)) {
    rl.close();
    fail("Enter a valid semver version, for example 0.1.1 or 1.0.0-beta.1.");
  }

  if (version === pkg.version) {
    rl.close();
    fail(`package.json is already at version ${version}. Choose a new version.`);
  }

  const gitTag = `v${version}`;
  if (commandSucceeds("git", ["rev-parse", "--verify", `refs/tags/${gitTag}`])) {
    rl.close();
    fail(`Git tag ${gitTag} already exists.`);
  }

  const publishedVersion = spawnSync("npm", ["view", `${pkg.name}@${version}`, "version"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (publishedVersion.status === 0 && publishedVersion.stdout.trim()) {
    rl.close();
    fail(`${pkg.name}@${version} already exists on npm.`);
  }

  const publishArgs = ["publish"];
  if (pkg.name.startsWith("@")) {
    publishArgs.push("--access", "public");
  }

  console.log("\nThis will:");
  console.log(`- run npm validation`);
  console.log(`- run npm version ${version} to update package.json/package-lock.json`);
  console.log(`- create a release commit and git tag ${gitTag}`);
  console.log(`- run npm ${publishArgs.join(" ")}`);

  const confirm = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    rl.close();
    fail("Publish cancelled.");
  }

  rl.close();

  run("npm", ["run", "validate"]);
  run("npm", ["version", version, "-m", "chore(release): v%s"]);
  run("npm", publishArgs);

  const pushRl = createInterface({ input, output });
  const push = (await pushRl.question(`Push current branch and ${gitTag} to origin? [y/N] `)).trim().toLowerCase();
  pushRl.close();

  if (push === "y" || push === "yes") {
    const branch = capture("git", ["branch", "--show-current"]);
    if (!branch) {
      fail(`Release was published, but git is in detached HEAD. Push ${gitTag} manually.`);
    }

    run("git", ["push", "origin", branch]);
    run("git", ["push", "origin", gitTag]);
  }

  console.log(`\nPublished ${pkg.name}@${version}.`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
