import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAIM_ORDER } from "./runner-service";

// "Run this step only" is a human sitting and watching. A runner does not poll again until its
// current batch drains, so behind arbitrary background work an operator-initiated step waited a
// median of 11 MINUTES before it even started — 23 minutes on the case that reported it, which is
// why the paused case looked dead (FR #0000101). Operator work jumps the queue.
test("operator-initiated (singleRun) jobs are claimed before anything else", () => {
  assert.deepEqual(CLAIM_ORDER[0], { singleRun: "desc" });
});

// ...and everything else keeps its stable case-then-sequence order, so a case's steps still run in
// order rather than being interleaved arbitrarily.
test("the remaining order is still case, then sequence", () => {
  assert.deepEqual(CLAIM_ORDER.slice(1), [{ caseRequestId: "asc" }, { sequence: "asc" }]);
});
