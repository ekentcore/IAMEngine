import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaseStatus, JobStatus, Mode } from "@prisma/client";
import { caseActionValidity, isBulkAction, BULK_ACTIONS, bulkCaseDecision, verifiableJobs, type CaseValidityState, type BulkCaseRow } from "./actions";

const state = (o: Partial<CaseValidityState>): CaseValidityState => ({
  status: (o.status ?? "queued") as CaseStatus,
  paused: o.paused ?? false,
  scheduled: o.scheduled ?? false,
  hasInflight: o.hasInflight ?? false,
  hasVerifiable: o.hasVerifiable ?? false,
});

// ── dispatch (resume) — only a paused, non-terminal case, but NOT a scheduled hold ────────────────
test("dispatch: valid for a paused, non-terminal case", () => {
  assert.deepEqual(caseActionValidity("dispatch", state({ status: "running", paused: true })), { valid: true });
});
test("dispatch: skips a case that isn't paused", () => {
  const r = caseActionValidity("dispatch", state({ status: "running", paused: false }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, "not paused");
});
test("dispatch: skips a SCHEDULED case (bulk-resuming would wipe its future schedule + run early)", () => {
  const r = caseActionValidity("dispatch", state({ status: "queued", paused: true, scheduled: true }));
  assert.equal(r.valid, false);
  assert.match(r.reason ?? "", /scheduled/);
});
test("dispatch: skips a terminal case even if paused", () => {
  for (const status of ["completed", "failed"] as const) {
    const r = caseActionValidity("dispatch", state({ status, paused: true }));
    assert.equal(r.valid, false, status);
    assert.equal(r.reason, `case is ${status}`);
  }
});

// ── pause — only an active (non-terminal, not-yet-paused) case ────────────────────────────────────
test("pause: valid for an active case", () => {
  for (const status of ["queued", "planning", "running", "needs_manual", "needs_approval"] as const) {
    assert.deepEqual(caseActionValidity("pause", state({ status, paused: false })), { valid: true }, status);
  }
});
test("pause: skips an already-paused case", () => {
  const r = caseActionValidity("pause", state({ status: "running", paused: true }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, "already paused");
});
test("pause: skips a terminal case", () => {
  const r = caseActionValidity("pause", state({ status: "completed" }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, "case is completed");
});

// ── cancel — valid when the case has in-flight steps to stop, EVEN IF paused (pause doesn't abort) ─
test("cancel: valid for a case with in-flight jobs (running, not paused)", () => {
  assert.deepEqual(caseActionValidity("cancel", state({ status: "running", paused: false, hasInflight: true })), { valid: true });
});
test("cancel: valid for a PAUSED case that still has in-flight jobs (pause doesn't stop them)", () => {
  assert.deepEqual(caseActionValidity("cancel", state({ status: "running", paused: true, hasInflight: true })), { valid: true });
});
test("cancel: skips a case with nothing in flight", () => {
  const r = caseActionValidity("cancel", state({ status: "queued", hasInflight: false }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, "nothing running to cancel");
});
test("cancel: skips a terminal case", () => {
  const r = caseActionValidity("cancel", state({ status: "failed", hasInflight: true }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, "case is failed");
});

// ── verify — NOT paused (else the reset jobs never get claimed), needs automated steps ────────────
test("verify: valid for a completed case with verifiable jobs", () => {
  assert.deepEqual(caseActionValidity("verify", state({ status: "completed", hasVerifiable: true })), { valid: true });
});
test("verify: skips a PAUSED case (reset verify jobs would never be claimed → stuck)", () => {
  const r = caseActionValidity("verify", state({ status: "completed", paused: true, hasVerifiable: true }));
  assert.equal(r.valid, false);
  assert.match(r.reason ?? "", /paused/);
});
test("verify: skips a case with no automated steps", () => {
  const r = caseActionValidity("verify", state({ status: "completed", hasVerifiable: false }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, "no automated steps to verify");
});

// ── bulkCaseDecision — scope + validity gating over a fetched row ─────────────────────────────────
const row = (o: Partial<BulkCaseRow>): BulkCaseRow => ({
  id: o.id ?? "c1",
  clientId: o.clientId ?? "cl1",
  status: (o.status ?? "running") as CaseStatus,
  pausedAt: o.pausedAt ?? null,
  pausedReason: o.pausedReason ?? null,
  jobs: o.jobs ?? [],
});
const job = (status: JobStatus, systemKey = "m365"): { mode: Mode; status: JobStatus; systemKey: string } => ({ mode: "api" as Mode, status, systemKey });

test("bulkCaseDecision: a missing case is skipped as not found", () => {
  assert.deepEqual(bulkCaseDecision("pause", undefined, null), { run: false, reason: "not found" });
});
test("bulkCaseDecision: an out-of-scope case is skipped as not found (never touched)", () => {
  const d = bulkCaseDecision("pause", row({ clientId: "hidden" }), ["visible-1", "visible-2"]);
  assert.deepEqual(d, { run: false, reason: "not found" });
});
test("bulkCaseDecision: in-scope + valid runs", () => {
  const d = bulkCaseDecision("pause", row({ clientId: "cl1", status: "running", pausedAt: null }), ["cl1"]);
  assert.deepEqual(d, { run: true });
});
test("bulkCaseDecision: in-scope but state-invalid is skipped with the validity reason", () => {
  const d = bulkCaseDecision("dispatch", row({ clientId: "cl1", status: "queued", pausedAt: new Date(), pausedReason: "scheduled" }), ["cl1"]);
  assert.equal((d as { run: false; reason: string }).run, false);
  assert.match((d as { run: false; reason: string }).reason, /scheduled/);
});
test("bulkCaseDecision: cancel sees in-flight jobs via the row's job projection", () => {
  const withInflight = bulkCaseDecision("cancel", row({ status: "running", pausedAt: new Date(), jobs: [job("running")] }), null);
  assert.deepEqual(withInflight, { run: true }); // paused but in-flight → cancellable
  const noInflight = bulkCaseDecision("cancel", row({ status: "running", jobs: [job("succeeded")] }), null);
  assert.equal((noInflight as { run: false; reason: string }).run, false);
});

// ── action guard ─────────────────────────────────────────────────────────────────────────────────
test("isBulkAction accepts the four actions and rejects anything else", () => {
  for (const a of BULK_ACTIONS) assert.equal(isBulkAction(a), true, a);
  for (const bad of ["trash", "delete", "", "Dispatch", 3, null, undefined]) assert.equal(isBulkAction(bad), false, String(bad));
});

// ── verifiableJobs — what "Verify everything" may re-queue as a validate-only pass ────────────────
const vj = (systemKey: string, status: JobStatus, mode: Mode = "api") => ({ mode, status, systemKey });

test("verifiableJobs: succeeded and failed automated steps are verifiable", () => {
  const jobs = [vj("m365", "succeeded"), vj("exchange", "failed")];
  assert.deepEqual(verifiableJobs(jobs).map((j) => j.systemKey), ["m365", "exchange"]);
});

test("verifiableJobs: a SKIPPED step is not verifiable — it never ran, and a validate-only pass would flip it to verified-green", () => {
  // The case-failure sweep skips pending steps; "Verify everything" must not launder them into done.
  const jobs = [vj("m365", "succeeded"), vj("egnyte", "skipped")];
  assert.deepEqual(verifiableJobs(jobs).map((j) => j.systemKey), ["m365"]);
});

test("verifiableJobs: ad-hoc, manual, and in-flight steps are excluded", () => {
  const jobs = [
    vj("m365-password-reset", "failed"), // ad-hoc: no validator — the sweep would flip a FAILED reset to succeeded
    vj("hardware", "succeeded", "manual"),
    vj("m365", "running"),
    vj("mimecast", "pending"),
  ];
  assert.deepEqual(verifiableJobs(jobs), []);
});
