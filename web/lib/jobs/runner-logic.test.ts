import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyGateOpen, deriveCaseStatus, isClaimable, shouldStandBy, type JobLite } from "./runner-logic";

function j(over: Partial<JobLite>): JobLite {
  return { id: "j", systemKey: over.id ?? "j", sequence: 0, mode: "api", status: "pending", requiresApproval: false, ...over };
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

test("isClaimable: completed case blocks; a FAILED case still runs its independent pending jobs", () => {
  const t = j({ id: "m365", sequence: 0 });
  assert.equal(isClaimable(t, [t], "completed"), false);
  // A failed case must NOT strand a pending job whose own deps are met — a different step failed.
  assert.equal(isClaimable(t, [t], "failed"), true);
  // ...but the per-job dependency gate still blocks a pending job whose prerequisite didn't succeed.
  const dep = j({ id: "egnyte", sequence: 1, dependsOn: ["m365"] });
  assert.equal(isClaimable(dep, [j({ id: "m365", sequence: 0, status: "failed" }), dep], "failed"), false);
});

test("isClaimable: a dependency FAILED but ACCEPTED (operator ignored) no longer blocks the dependent", () => {
  // Six One: directory-sync fails, operator marks it accepted -> m365 must stop waiting on it.
  const m365 = j({ id: "m365", sequence: 1, dependsOn: ["directory-sync"] });
  const failedDep = j({ id: "directory-sync", sequence: 0, status: "failed" });
  assert.equal(isClaimable(m365, [failedDep, m365], "running"), false); // failed -> blocks
  assert.equal(isClaimable(m365, [{ ...failedDep, accepted: true }, m365], "running"), true); // accepted -> proceeds
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

test("DAG gate: a job waits only on its OWN dependencies, not unrelated earlier steps", () => {
  // mimecast depends on m365 only; egnyte (earlier sequence, still pending) must NOT block it.
  const m365 = j({ id: "m365", sequence: 1, status: "succeeded" });
  const egnyte = j({ id: "egnyte", sequence: 2, status: "pending" });
  const mimecast = j({ id: "mimecast", sequence: 3, dependsOn: ["m365"] });
  assert.equal(dependencyGateOpen(mimecast, [m365, egnyte, mimecast]), true);
});

test("DAG gate: still blocked while a declared dependency is unfinished", () => {
  const m365 = j({ id: "m365", sequence: 1, status: "running" });
  const mimecast = j({ id: "mimecast", sequence: 3, dependsOn: ["m365"] });
  assert.equal(dependencyGateOpen(mimecast, [m365, mimecast]), false);
});

test("DAG gate: independent branches are claimable in parallel once the shared root succeeds", () => {
  const m365 = j({ id: "m365", sequence: 0, status: "succeeded" });
  const a = j({ id: "mimecast", sequence: 1, dependsOn: ["m365"] });
  const b = j({ id: "spanning", sequence: 2, dependsOn: ["m365"] });
  const c = j({ id: "egnyte", sequence: 3, dependsOn: [] });
  const all = [m365, a, b, c];
  assert.equal(dependencyGateOpen(a, all), true);
  assert.equal(dependencyGateOpen(b, all), true);
  assert.equal(dependencyGateOpen(c, all), true);
});

test("DAG gate: a dependency on a system not in the case is vacuously satisfied", () => {
  const only = j({ id: "mimecast", sequence: 0, dependsOn: ["m365"] });
  assert.equal(dependencyGateOpen(only, [only]), true);
});

test("legacy gate (no persisted dependsOn) keeps strict sequence order", () => {
  const early = j({ id: "egnyte", sequence: 1, status: "pending" });
  const late = j({ id: "mimecast", sequence: 2 }); // dependsOn undefined -> legacy rule
  assert.equal(dependencyGateOpen(late, [early, late]), false);
});

test("shouldStandBy: a strictly higher-priority peer online -> stand by; else claim", () => {
  // primary=1, this=2 -> stand by while primary (1) is online
  assert.equal(shouldStandBy(2, [1]), true);
  // primary offline (not in the online list) -> this backup takes over
  assert.equal(shouldStandBy(2, []), false);
  assert.equal(shouldStandBy(2, [2, 3]), false); // only equal/lower-precedence peers online -> claim
  // equal priority peers load-balance (no stand-by) — preserves pre-failover behavior
  assert.equal(shouldStandBy(100, [100, 100]), false);
  // this IS the primary (lowest) -> never stands by
  assert.equal(shouldStandBy(1, [2, 3, 100]), false);
});
