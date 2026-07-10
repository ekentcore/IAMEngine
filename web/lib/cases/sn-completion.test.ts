import { test } from "node:test";
import assert from "node:assert/strict";
import { hasInFlightJob, manualCompletionFlip, planCompletion } from "./sn-completion";

const job = (id: string, status: string) => ({ id, status });
const ids = (plan: ReturnType<typeof planCompletion<{ id: string; status: string }>>) =>
  plan.ok ? plan.flip.map((j) => j.id) : plan;

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
  assert.deepEqual(ids(plan), ["c", "d", "e"]);
});

test("all steps already terminal-done → nothing to flip", () => {
  assert.deepEqual(ids(planCompletion([job("a", "succeeded"), job("b", "skipped")])), []);
});

test("a case with no jobs is completable", () => {
  assert.deepEqual(ids(planCompletion([])), []);
});

test("hasInFlightJob matches only dispatched/running", () => {
  assert.equal(hasInFlightJob([job("a", "pending"), job("b", "failed")]), false);
  assert.equal(hasInFlightJob([job("a", "dispatched")]), true);
});

test("manualCompletionFlip records the prior state so unmarking can restore it", () => {
  const now = new Date("2026-07-10T12:00:00Z");
  const flip = manualCompletionFlip({ status: "failed", result: { attempt: 2 }, error: "egnyte 403" }, now);
  assert.deepEqual(flip, {
    status: "succeeded",
    result: { attempt: 2, manualCompletion: true, priorStatus: "failed", priorError: "egnyte 403" },
    error: null,
    finishedAt: now,
  });
  // no error → no priorError key (nothing to restore)
  const clean = manualCompletionFlip({ status: "manual", result: null, error: null }, now);
  assert.deepEqual(clean.result, { manualCompletion: true, priorStatus: "manual" });
});
