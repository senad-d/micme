import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Opt-in: put the installed worker on PATH and run this file with node --test.
const options = { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] };

function assertWorkerError(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /^[^\r\n]+\n$/);
  const event = JSON.parse(result.stdout);
  assert.equal(event.type, "error");
  assert.equal(typeof event.message, "string");
  assert.ok(event.message.length > 0);
}

test("the no-model probe writes only Worker v1 and an LF", () => {
  const result = spawnSync("micme-live", ["--protocol-version"], options);
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "1\n");
  assert.equal(result.stderr, "");
});

test("extra arguments do not take the version probe path", () => {
  assertWorkerError(spawnSync("micme-live", ["--protocol-version", "--translate"], options));
});

test("invoking the decoder without usable weights fails rather than announcing readiness", () => {
  assertWorkerError(spawnSync("micme-live", ["--model", "", "--vad-model", "", "--language", "en"], options));
});
