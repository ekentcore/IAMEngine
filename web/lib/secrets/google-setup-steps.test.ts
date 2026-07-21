import test from "node:test";
import assert from "node:assert/strict";
import { stepOf, needsActionStep, NEEDS_ACTION_STEP } from "./google-setup-steps";

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
