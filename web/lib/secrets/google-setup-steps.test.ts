import test from "node:test";
import assert from "node:assert/strict";
import { stepOf, needsActionStep, NEEDS_ACTION_STEP, reopenPhaseFor, reopenNoteFor } from "./google-setup-steps";

test("stepOf maps every backend stage to its tracker step", () => {
  assert.equal(stepOf("eligibility"), 0);
  assert.equal(stepOf("oauth-dispatch"), 0);
  assert.equal(stepOf("oauth-code"), 0);
  assert.equal(stepOf("provision"), 1);
  assert.equal(stepOf("dwd-dispatch"), 2);
  assert.equal(stepOf("dwd-grant"), 2);
  assert.equal(stepOf("verify"), 3);
  assert.equal(stepOf("write"), 3);
  assert.equal(stepOf("done"), 4);
});

test("stepOf returns -1 for stages with no numbered step", () => {
  assert.equal(stepOf("error"), -1);
  assert.equal(stepOf(null), -1);
  assert.equal(stepOf(undefined), -1);
  assert.equal(stepOf("not-a-real-stage"), -1);
});

test("needsActionStep flags the DWD step for a needs_action run, and nothing for any other status", () => {
  assert.equal(NEEDS_ACTION_STEP, 2);
  assert.equal(needsActionStep("needs_action"), 2);
  for (const status of ["pending", "running", "done", "failed", "skipped", null, undefined]) {
    assert.equal(needsActionStep(status as string | null | undefined), null);
  }
});

test("reopenPhaseFor: a live or credential-bearing run shows progress; a stale failed/cancelled/skipped run opens the form", () => {
  // Live, or a run that vaulted a credential -> progress (show status / the wired id).
  for (const status of ["running", "pending", "done", "needs_action"]) {
    assert.equal(reopenPhaseFor(status), "progress", `${status} should reopen on progress`);
  }
  // A stale terminal run whose only outcome is an error -> the FORM, so the secret id can be entered.
  for (const status of ["failed", "cancelled", "skipped", "unknown", null, undefined]) {
    assert.equal(reopenPhaseFor(status as string | null | undefined), "form", `${status} should reopen on the form`);
  }
});

test("reopenNoteFor: only a failed run gets a note, and it carries the prior error", () => {
  assert.equal(
    reopenNoteFor("failed", "the Google sign-in did not complete: Couldn't sign you in"),
    "The last run failed: the Google sign-in did not complete: Couldn't sign you in",
  );
  // Failed but no error text -> a generic retry nudge, never an empty "failed: ".
  assert.equal(reopenNoteFor("failed", null), "The last run failed. Re-enter the super-admin secret id to try again.");
  assert.equal(reopenNoteFor("failed", "   "), "The last run failed. Re-enter the super-admin secret id to try again.");
  // Any non-failed status -> no note (a fresh/cancelled/skipped form shouldn't shout an error).
  for (const status of ["cancelled", "skipped", "done", "running", null, undefined]) {
    assert.equal(reopenNoteFor(status as string | null | undefined, "x"), null);
  }
});
