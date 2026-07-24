import test from "node:test";
import assert from "node:assert/strict";
import { computeVerdict, verdictLabel } from "./deployment-status";

test("unknown when we don't know the running or the latest commit", () => {
  assert.equal(computeVerdict(null, "abc", 0), "unknown");
  assert.equal(computeVerdict("abc", null, null), "unknown");
  assert.equal(computeVerdict(null, null, null), "unknown");
});

test("up-to-date when SHAs match", () => {
  assert.equal(computeVerdict("abc123", "abc123", null), "up-to-date");
});

test("up-to-date when compare says 0 behind (running is at/ahead of the branch tip)", () => {
  assert.equal(computeVerdict("local9", "mainTip", 0), "up-to-date");
});

test("behind when SHAs differ and it is genuinely behind", () => {
  assert.equal(computeVerdict("old", "new", 3), "behind");
});

test("behind when SHAs differ but the distance couldn't be measured", () => {
  assert.equal(computeVerdict("old", "new", null), "behind");
});

test("labels read correctly, pluralizing the count", () => {
  assert.equal(verdictLabel("up-to-date", 0), "Running the latest push");
  assert.equal(verdictLabel("behind", 1), "1 commit behind — redeploy to update");
  assert.equal(verdictLabel("behind", 4), "4 commits behind — redeploy to update");
  assert.equal(verdictLabel("behind", null), "Not the latest push — redeploy to update");
  assert.match(verdictLabel("unknown", null), /Couldn't determine/);
});
