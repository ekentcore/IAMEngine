import { test } from "node:test";
import assert from "node:assert/strict";
import { previewDirectorySync } from "./directory-sync-preview";

test("renders the delta-sync trigger with the in-progress guard", () => {
  const out = previewDirectorySync("onboard", { host: "61c-dc01" }, null, "acme.com");
  assert.match(out, /61c-dc01/);
  assert.match(out, /Get-ADSyncScheduler/);
  assert.match(out, /Start-ADSyncSyncCycle -PolicyType Delta/);
});

test("null config does not throw", () => {
  assert.match(previewDirectorySync("offboard", null, null, "acme.com"), /Start-ADSyncSyncCycle/);
});
