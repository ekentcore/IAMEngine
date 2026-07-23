import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyGateOpen, deriveCaseStatus, isClaimable, shouldStandBy, setupGateBlocks, maintenanceBlocks, type JobLite, type MaintenanceScope } from "./runner-logic";
import { offboardCandidatesOf, offboardCandidateQuery } from "./runner-service";

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

test("deriveCaseStatus: a failure the operator ACCEPTED doesn't fail the case", () => {
  // "Ignore" on a failed step resolves its run-log outcome; the run report already shows it verified.
  // The case badge must agree, or the list reads "failed" on a case whose every step reads green.
  assert.equal(deriveCaseStatus([j({ status: "succeeded" }), j({ status: "failed", accepted: true })]), "completed");
});

test("deriveCaseStatus: an accepted failure alongside a real one still fails the case", () => {
  assert.equal(
    deriveCaseStatus([j({ id: "duo", status: "failed", accepted: true }), j({ id: "m365", status: "failed" })]),
    "failed"
  );
});

test("deriveCaseStatus: an accepted failure doesn't mask still-open api work", () => {
  assert.equal(deriveCaseStatus([j({ status: "failed", accepted: true }), j({ status: "pending" })]), "running");
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

test("ad-hoc password-reset jobs never affect the case status (failed reset can't fail the case)", () => {
  const done = [j({ id: "m365", sequence: 0, status: "succeeded" }), j({ id: "ad", sequence: 1, status: "succeeded" })];
  // a FAILED ad-hoc reset must not flip a completed case to failed
  assert.equal(deriveCaseStatus([...done, j({ id: "m365-password-reset", sequence: 9, status: "failed" })]), "completed");
  // a PENDING/RUNNING ad-hoc reset must not read as "the case is still running"
  assert.equal(deriveCaseStatus([...done, j({ id: "ad-password-reset", sequence: 9, status: "pending" })]), "completed");
  assert.equal(deriveCaseStatus([...done, j({ id: "google-password-reset", sequence: 9, status: "running" })]), "completed");
});

test("ad-hoc password-reset jobs never gate other steps (legacy sequence rule included)", () => {
  // legacy rule (no dependsOn): every earlier api job gates — except an ad-hoc reset.
  const late = j({ id: "mimecast", sequence: 5 });
  const reset = j({ id: "ad-password-reset", sequence: 1, status: "pending" });
  assert.equal(dependencyGateOpen(late, [reset, late]), true);
});

test("ad-hoc spanning-force-sync is treated like other ad-hoc actions (no effect on case status/gate)", () => {
  const done = [j({ id: "m365", sequence: 0, status: "succeeded" }), j({ id: "spanning", sequence: 1, status: "succeeded" })];
  // a FAILED/pending force-sync must not flip or hold a completed case
  assert.equal(deriveCaseStatus([...done, j({ id: "spanning-force-sync", sequence: 9, status: "failed" })]), "completed");
  assert.equal(deriveCaseStatus([...done, j({ id: "spanning-force-sync", sequence: 9, status: "pending" })]), "completed");
  // and it never gates a real step
  const late = j({ id: "mimecast", sequence: 5 });
  const sync = j({ id: "spanning-force-sync", sequence: 1, status: "pending" });
  assert.equal(dependencyGateOpen(late, [sync, late]), true);
});

test("setupGateBlocks: default policy never blocks; enforce blocks only failing-unattested", () => {
  const off = { enforceTested: false };
  const on = { enforceTested: true };
  for (const test of ["ok", "fail", "untested", "not_needed", "unknown"] as const) {
    assert.equal(setupGateBlocks({ test, attested: false }, off).block, false);
  }
  assert.equal(setupGateBlocks({ test: "fail", attested: false }, on).block, true);
  assert.match(setupGateBlocks({ test: "fail", attested: false }, on).reason ?? "", /attest/i);
  assert.equal(setupGateBlocks({ test: "fail", attested: true }, on).block, false); // attestation overrides
  assert.equal(setupGateBlocks({ test: "untested", attested: false }, on).block, false); // never strand legacy clients
  assert.equal(setupGateBlocks({ test: "unknown", attested: false }, on).block, false);
  assert.equal(setupGateBlocks({ test: "ok", attested: false }, on).block, false);
});

// --- maintenance / drain admission gate (feature #7) ---------------------------------------------
const NONE: MaintenanceScope = { global: false, systems: [], clients: [] };
const cand = (systemKey: string, clientId: string) => ({ systemKey, clientId });

test("maintenanceBlocks: empty scope blocks nothing (fail-open)", () => {
  assert.equal(maintenanceBlocks(NONE, cand("m365", "c1")), false);
  assert.equal(maintenanceBlocks(NONE, cand("mimecast", "c2")), false);
});

test("maintenanceBlocks: a global drain blocks every candidate", () => {
  const scope: MaintenanceScope = { global: true, systems: [], clients: [] };
  assert.equal(maintenanceBlocks(scope, cand("m365", "c1")), true);
  assert.equal(maintenanceBlocks(scope, cand("anything", "whoever")), true);
});

test("maintenanceBlocks: a paused system blocks only that systemKey", () => {
  const scope: MaintenanceScope = { global: false, systems: ["mimecast"], clients: [] };
  assert.equal(maintenanceBlocks(scope, cand("mimecast", "c1")), true);  // paused system, any client
  assert.equal(maintenanceBlocks(scope, cand("mimecast", "c2")), true);
  assert.equal(maintenanceBlocks(scope, cand("m365", "c1")), false);      // sibling system on same case still runs
});

test("maintenanceBlocks: a paused client blocks only that client id", () => {
  const scope: MaintenanceScope = { global: false, systems: [], clients: ["c1"] };
  assert.equal(maintenanceBlocks(scope, cand("m365", "c1")), true);       // every system for the paused client
  assert.equal(maintenanceBlocks(scope, cand("mimecast", "c1")), true);
  assert.equal(maintenanceBlocks(scope, cand("m365", "c2")), false);      // another client untouched
});

test("maintenanceBlocks: system-pause and client-pause combine (either matches)", () => {
  const scope: MaintenanceScope = { global: false, systems: ["spanning"], clients: ["c9"] };
  assert.equal(maintenanceBlocks(scope, cand("spanning", "c1")), true); // matched by system
  assert.equal(maintenanceBlocks(scope, cand("m365", "c9")), true);     // matched by client
  assert.equal(maintenanceBlocks(scope, cand("m365", "c1")), false);    // matched by neither
});

// --- offboard-target candidates ------------------------------------------------------------------
// A candidate with no UPN is unusable: the operator could pick it and we still wouldn't know who they
// meant, so it must never reach the picker.
test("offboardCandidatesOf: parses PascalCase + camelCase, drops candidates with no UPN", () => {
  assert.equal(offboardCandidatesOf(null).length, 0);
  assert.equal(offboardCandidatesOf({ Actions: [] }).length, 0);
  const pascal = offboardCandidatesOf({ Candidates: [{ id: "1", upn: "a@x.com", displayName: "A" }, { id: "2", displayName: "no upn" }] });
  assert.equal(pascal.length, 1);
  assert.equal(pascal[0].upn, "a@x.com");
  const camel = offboardCandidatesOf({ candidates: [{ upn: "b@x.com", displayName: "B", samAccountName: "b" }] });
  assert.equal(camel.length, 1);
  assert.equal(camel[0].samAccountName, "b");
  assert.equal(camel[0].id, "b@x.com"); // falls back to the UPN when the directory gave no id
});

test("offboardCandidateQuery: the name we searched for, or null", () => {
  assert.equal(offboardCandidateQuery({ CandidateQuery: "Parth Shah" }), "Parth Shah");
  assert.equal(offboardCandidateQuery({ candidateQuery: "" }), null);
  assert.equal(offboardCandidateQuery({}), null);
});

// FR #5: an unlicensed M365 user has no mailbox, so Mimecast/Spanning can never discover them —
// recordResult holds those jobs (request.hold) and clears the hold on a licensed re-run.
test("isClaimable: a held job is not claimable even with its gate open", () => {
  const t = j({ id: "mimecast", sequence: 1, hold: "waiting for an M365 license" });
  assert.equal(isClaimable(t, [j({ id: "m365", sequence: 0, status: "succeeded" }), t], "running"), false);
  // hold cleared -> claimable again
  const cleared = { ...t, hold: null };
  assert.equal(isClaimable(cleared, [j({ id: "m365", sequence: 0, status: "succeeded" }), cleared], "running"), true);
});
