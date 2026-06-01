import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyGateOpen, deriveCaseStatus, isClaimable, type JobLite } from "./runner-logic";

function j(over: Partial<JobLite>): JobLite {
  return { id: "j", sequence: 0, mode: "api", status: "pending", requiresApproval: false, ...over };
}

test("dependency gate: open only when all earlier api jobs have succeeded/skipped", () => {
  const target = j({ id: "m365", sequence: 3 });
  const ok = [j({ id: "sn", sequence: 0, status: "succeeded" }), j({ id: "ad", sequence: 1, status: "skipped" }), target];
  assert.equal(dependencyGateOpen(target, ok), true);
  const blocked = [j({ id: "ad", sequence: 1, status: "running" }), target];
  assert.equal(dependencyGateOpen(target, blocked), false);
});

test("dependency gate ignores earlier manual/browser jobs (out-of-band checklist)", () => {
  const target = j({ id: "m365", sequence: 2 });
  const jobs = [j({ id: "welcome", sequence: 0, mode: "manual", status: "manual" }), target];
  assert.equal(dependencyGateOpen(target, jobs), true);
});

test("deriveCaseStatus: all succeeded -> completed", () => {
  assert.equal(deriveCaseStatus([j({ status: "succeeded" }), j({ status: "succeeded" })]), "completed");
});

test("deriveCaseStatus: any failed -> failed", () => {
  assert.equal(deriveCaseStatus([j({ status: "succeeded" }), j({ status: "failed" })]), "failed");
});

test("deriveCaseStatus: api work still pending -> running", () => {
  assert.equal(deriveCaseStatus([j({ status: "succeeded" }), j({ status: "pending" })]), "running");
});

test("deriveCaseStatus: only manual checklist left -> needs_manual", () => {
  assert.equal(deriveCaseStatus([j({ status: "succeeded" }), j({ mode: "manual", status: "manual" })]), "needs_manual");
});

test("deriveCaseStatus: a gated approval job blocks -> needs_approval", () => {
  assert.equal(deriveCaseStatus([j({ status: "succeeded" }), j({ status: "pending", requiresApproval: true })]), "needs_approval");
});

test("isClaimable: gate open + non-terminal case -> claimable", () => {
  const t = j({ id: "m365", sequence: 1 });
  assert.equal(isClaimable(t, [j({ sequence: 0, status: "succeeded" }), t], "running"), true);
});

test("isClaimable: never claim jobs on a failed or completed case", () => {
  const t = j({ id: "m365", sequence: 0 });
  assert.equal(isClaimable(t, [t], "failed"), false);
  assert.equal(isClaimable(t, [t], "completed"), false);
});

test("isClaimable: approval-gated job not claimable unless approved", () => {
  const gated = j({ id: "x", sequence: 0, requiresApproval: true });
  assert.equal(isClaimable(gated, [gated], "needs_approval"), false);
  assert.equal(isClaimable({ ...gated, approved: true }, [gated], "needs_approval"), true);
});

test("isClaimable: closed dependency gate -> not claimable", () => {
  const t = j({ id: "m365", sequence: 1 });
  assert.equal(isClaimable(t, [j({ sequence: 0, status: "running" }), t], "running"), false);
});
