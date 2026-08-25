import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudObjectFor } from "./cloud-object";

test("a succeeded m365 result with an anchor is read", () => {
  const out = cloudObjectFor({ status: "succeeded", envelope: { UserId: "u1", OnPremImmutableId: "abc==", OnPremSyncEnabled: true } });
  assert.deepEqual(out, { immutableId: "abc==", syncEnabled: true, userId: "u1", read: true });
});

test("a succeeded m365 result that genuinely found no cloud user is still READ", () => {
  // The check may legitimately report "no cloud object, a fresh sync will anchor it" — but only when
  // we actually looked. That is this case.
  const out = cloudObjectFor({ status: "succeeded", envelope: { UserId: null, OnPremImmutableId: null, OnPremSyncEnabled: null } });
  assert.equal(out.read, true);
  assert.equal(out.userId, null);
});

test("NO m365 job at all is not read, and says so (FR #0000093)", () => {
  const out = cloudObjectFor(null);
  assert.equal(out.read, false);
  assert.match(String(out.reason), /did not run/i);
});

test("a FAILED m365 job is not read, and names the status (FR #0000093)", () => {
  // UM0029901: m365 failed, the operator accepted the failure to let the case proceed, the check ran
  // anyway and reported an all-clear for a comparison it never performed.
  const out = cloudObjectFor({ status: "failed", envelope: null });
  assert.equal(out.read, false);
  assert.match(String(out.reason), /failed/i);
});

test("a SUCCEEDED m365 job whose result carries no anchor fields is not read (UM0030327)", () => {
  // Same blank state by a different route — e.g. a manually-completed step, whose result is
  // { priorStatus, manualCompletion } and carries no UserId.
  const out = cloudObjectFor({ status: "succeeded", envelope: { priorStatus: "failed", manualCompletion: true } });
  assert.equal(out.read, false);
  assert.match(String(out.reason), /no Entra object/i);
});
