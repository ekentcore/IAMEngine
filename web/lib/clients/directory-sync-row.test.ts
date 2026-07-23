import { test } from "node:test";
import assert from "node:assert/strict";
import { directorySyncRow } from "./directory-sync-row";

test("directorySyncRow ordered after active-directory has null config and depends on AD", () => {
  const row = directorySyncRow({ orderAfter: "active-directory" });
  assert.equal(row.systemKey, "directory-sync");
  assert.equal(row.mode, "api");
  assert.equal(row.onboardWhen, "always");
  assert.equal(row.offboardWhen, "always");
  assert.deepEqual(row.dependsOn, ["active-directory"]);
  assert.deepEqual(row.secretNames, ["ad-dc"]);
  assert.equal(row.requiresApproval, false);
  assert.equal(row.captureEvidence, false);
  assert.equal(row.config, null);
});

test("directorySyncRow ordered after exchange waits for mailbox", () => {
  const row = directorySyncRow({ orderAfter: "exchange" });
  assert.deepEqual(row.dependsOn, ["exchange"]);
  assert.deepEqual(row.config, {
    onboard: { command: "Start-ADSyncSyncCycle -PolicyType Delta", waitForMailbox: true },
  });
});
