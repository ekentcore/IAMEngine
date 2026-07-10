import { test } from "node:test";
import assert from "node:assert/strict";
import { planCompletion } from "./sn-completion";

const job = (id: string, status: string) => ({ id, status });

test("refuses while a step is dispatched or running", () => {
  assert.deepEqual(planCompletion([job("a", "succeeded"), job("b", "dispatched")]), { ok: false, reason: "in_flight" });
  assert.deepEqual(planCompletion([job("a", "running")]), { ok: false, reason: "in_flight" });
});

test("flips pending, manual and failed steps; leaves succeeded and skipped alone", () => {
  const plan = planCompletion([
    job("a", "succeeded"),
    job("b", "skipped"),
    job("c", "manual"),
    job("d", "failed"),
    job("e", "pending"),
  ]);
  assert.deepEqual(plan, { ok: true, flipIds: ["c", "d", "e"] });
});

test("all steps already terminal-done → nothing to flip", () => {
  assert.deepEqual(planCompletion([job("a", "succeeded"), job("b", "skipped")]), { ok: true, flipIds: [] });
});

test("a case with no jobs is completable", () => {
  assert.deepEqual(planCompletion([]), { ok: true, flipIds: [] });
});
