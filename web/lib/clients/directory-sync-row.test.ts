import { test } from "node:test";
import assert from "node:assert/strict";
import type { EditableSystem } from "./types";
import { directorySyncRow, withDirectorySync } from "./directory-sync-row";

const ad: EditableSystem = {
  systemKey: "active-directory", mode: "api", onboardWhen: "always", offboardWhen: "always",
  dependsOn: [], requiresApproval: false, captureEvidence: false, secretNames: ["ad-dc"], config: null,
};
const m365: EditableSystem = {
  systemKey: "m365", mode: "api", onboardWhen: "always", offboardWhen: "always",
  dependsOn: [], requiresApproval: false, captureEvidence: false, secretNames: ["m365"], config: null,
};

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

test("withDirectorySync appends exactly one row and keeps existing systems", () => {
  const out = withDirectorySync([ad, m365], { orderAfter: "active-directory" });
  assert.equal(out.length, 3);
  assert.deepEqual(out.slice(0, 2), [ad, m365]); // existing untouched, order preserved
  assert.equal(out[2].systemKey, "directory-sync");
});

test("withDirectorySync is idempotent when directory-sync already present", () => {
  const existing = [ad, directorySyncRow({ orderAfter: "exchange" }), m365];
  const out = withDirectorySync(existing, { orderAfter: "active-directory" });
  assert.equal(out, existing); // same reference — unchanged
});
