// Shared per-case run-control operations: pause/resume, cancel, verify. The single-case routes
// (/api/cases/:id/{pause,cancel,verify}) and the bulk route (/api/cases/bulk) both call these so the
// mutation + audit logic lives once. Each helper does EXACTLY what the single route body used to do
// (same DB writes, same audit rows, same scheduledFor clearing) — the single routes keep their own
// guard + caseInScope + 404 messaging around the call.
import { Prisma } from "@prisma/client";
import type { PrismaClient, CaseStatus, JobStatus, Mode } from "@prisma/client";
import { recordAudit, actorLabel } from "@/lib/auth/audit";
import type { ActingUser } from "@/lib/auth/guard";
import { scopeAllows, type ClientScope } from "@/lib/auth/client-scope";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { ADHOC_SYSTEM_KEYS } from "@/lib/jobs/adhoc";

// Outcome of a mutation helper: `ok` carries the same JSON body the single route returns (minus its
// own `ok: true`); `notFound` lets the caller pick its 404 wording ("not found" vs "unknown case").
export type CaseMutationResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; notFound: true };

// Pause (paused=true) or resume (paused=false) a case. Resume is what "dispatch" means in the bulk UI:
// there's no separate dispatch route — clearing the pause lets the runner claim the pending jobs.
// EITHER direction clears any pending schedule (the operator is taking manual control), matching the
// single pause route exactly.
export async function setCasePaused(db: PrismaClient, id: string, user: ActingUser | null | undefined, paused: boolean): Promise<CaseMutationResult> {
  const c = await db.caseRequest.findUnique({ where: { id }, select: { id: true, clientId: true } });
  if (!c) return { ok: false, notFound: true };
  await db.caseRequest.update({
    where: { id },
    data: { pausedAt: paused ? new Date() : null, pausedReason: paused ? "operator" : null, scheduledFor: null, scheduledBy: null },
  });
  await recordAudit(paused ? "case.pause" : "case.resume", { user, caseRequestId: id, clientId: c.clientId });
  return { ok: true, result: { paused } };
}

// Stop every in-flight (dispatched/running) step and pause the case so nothing further is claimed.
export async function cancelCase(db: PrismaClient, id: string, user: ActingUser | null | undefined): Promise<CaseMutationResult> {
  const c = await db.caseRequest.findUnique({ where: { id }, select: { id: true, clientId: true } });
  if (!c) return { ok: false, notFound: true };
  const inflight = await db.job.findMany({ where: { caseRequestId: id, status: { in: ["dispatched", "running"] } }, select: { id: true } });
  const svc = makeRunnerService(db);
  let stopped = 0;
  for (const j of inflight) {
    try { await svc.stopJob(j.id, actorLabel(user, "ui:cancel")); stopped++; } catch { /* already terminal / lost the race — ignore */ }
  }
  await db.caseRequest.update({ where: { id }, data: { pausedAt: new Date(), pausedReason: "operator", scheduledFor: null, scheduledBy: null } });
  await recordAudit("case.cancel", { user, caseRequestId: id, clientId: c.clientId, detail: { stopped } });
  return { ok: true, result: { stopped } };
}

// The automated (api) steps that "Verify everything" re-validates: terminal, non-ad-hoc. Ad-hoc
// password resets have no validator, so the no-validator sweep would flip even a FAILED reset to a
// fresh "succeeded" — exclude them. Shared so verifyCase and the bulk validity filter agree.
export function verifiableJobs<T extends { mode: Mode; status: JobStatus; systemKey: string }>(jobs: T[]): T[] {
  return jobs.filter((j) => j.mode === "api" && ["succeeded", "failed", "skipped"].includes(j.status) && !ADHOC_SYSTEM_KEYS.includes(j.systemKey));
}

// Reset every terminal automated step to a pending validate-only job and reopen the case so the claim
// loop re-runs the read-only validator. No mutation is re-run.
export async function verifyCase(db: PrismaClient, id: string, user: ActingUser | null | undefined): Promise<CaseMutationResult> {
  const c = await db.caseRequest.findUnique({
    where: { id },
    select: { id: true, jobs: { select: { id: true, systemKey: true, mode: true, status: true, request: true, error: true } } },
  });
  if (!c) return { ok: false, notFound: true };
  const targets = verifiableJobs(c.jobs);
  if (targets.length === 0) return { ok: true, result: { verifying: 0, note: "no automated steps to verify" } };

  await db.$transaction(
    targets.map((j) => {
      const req = { ...((j.request ?? {}) as Record<string, unknown>), validateOnly: true };
      return db.job.update({
        where: { id: j.id },
        data: { status: "pending", assignedAgentId: null, validation: Prisma.DbNull, progress: Prisma.DbNull, error: null, finishedAt: null, request: req as Prisma.InputJsonValue },
      });
    })
  );
  // Reopen so the claim loop dispatches the verify jobs; clear verifiedAt so the UI shows "verifying"
  // (not a stale "Account verified") until this pass finishes.
  await db.caseRequest.update({ where: { id: c.id }, data: { status: "queued", verifiedAt: null } });
  // Preserve prior errors on failed steps so a verify pass doesn't erase why a step originally failed.
  const cleared = targets.filter((j) => j.status === "failed").map((j) => ({ jobId: j.id, error: j.error }));
  await recordAudit("case.verify", { user, caseRequestId: c.id, detail: { steps: targets.length, clearedFailed: cleared } });
  return { ok: true, result: { verifying: targets.length } };
}

// ── Bulk action dispatch ──────────────────────────────────────────────────────────────────────
// The four run-control actions the bulk endpoint applies across selected cases. "dispatch" resumes a
// paused case (unpause → runner claims its pending jobs); it can NEVER skip a per-job approval gate.
export const BULK_ACTIONS = ["dispatch", "pause", "cancel", "verify"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export function isBulkAction(v: unknown): v is BulkAction {
  return typeof v === "string" && (BULK_ACTIONS as readonly string[]).includes(v);
}

// The minimal case state the validity filter needs — derivable from a cheap select.
export type CaseValidityState = {
  status: CaseStatus; // queued/planning/running/needs_manual/needs_approval/completed/failed
  paused: boolean; // pausedAt != null
  scheduled: boolean; // pausedReason === "scheduled" — held with a FUTURE auto-resume time
  hasInflight: boolean; // has dispatched/running jobs (cancel stops these even on a paused case)
  hasVerifiable: boolean; // has terminal automated (non-ad-hoc) steps to re-validate
};

// Pure: is `action` sensible for a case in this state? The bulk route skips invalid cases with the
// returned reason rather than erroring the whole batch. Rules (terminal = completed | failed):
//   dispatch → paused + non-terminal, but NOT a scheduled hold (bulk-resuming would wipe its future
//              schedule and run it — possibly a destructive offboard — days early; resume those per-case)
//   pause    → active: non-terminal and not already paused
//   cancel   → non-terminal AND has in-flight (dispatched/running) steps to stop — a paused case can
//              still have live jobs (pause doesn't abort them), so this is NOT gated on !paused
//   verify   → NOT paused (a paused case's reset verify jobs are never claimed → stuck), and has
//              automated steps to re-validate. Terminal (completed) is the normal case to verify.
export function caseActionValidity(action: BulkAction, s: CaseValidityState): { valid: boolean; reason?: string } {
  const terminal = s.status === "completed" || s.status === "failed";
  switch (action) {
    case "dispatch":
      if (terminal) return { valid: false, reason: `case is ${s.status}` };
      if (!s.paused) return { valid: false, reason: "not paused" };
      if (s.scheduled) return { valid: false, reason: "scheduled — resume it individually to run now" };
      return { valid: true };
    case "pause":
      if (terminal) return { valid: false, reason: `case is ${s.status}` };
      if (s.paused) return { valid: false, reason: "already paused" };
      return { valid: true };
    case "cancel":
      if (terminal) return { valid: false, reason: `case is ${s.status}` };
      if (!s.hasInflight) return { valid: false, reason: "nothing running to cancel" };
      return { valid: true };
    case "verify":
      if (s.paused) return { valid: false, reason: "paused — resume it before verifying" };
      if (!s.hasVerifiable) return { valid: false, reason: "no automated steps to verify" };
      return { valid: true };
  }
}

// Run one already-validated action against one case (the mutation helpers audit internally).
export function runBulkAction(db: PrismaClient, action: BulkAction, id: string, user: ActingUser | null | undefined): Promise<CaseMutationResult> {
  switch (action) {
    case "dispatch": return setCasePaused(db, id, user, false);
    case "pause": return setCasePaused(db, id, user, true);
    case "cancel": return cancelCase(db, id, user);
    case "verify": return verifyCase(db, id, user);
  }
}

export type BulkResult = { id: string; ok: boolean; error?: string; skipped?: string };
// A row from the batch fetch — everything the decision needs. `jobs` is a cheap projection.
export type BulkCaseRow = {
  id: string;
  clientId: string | null;
  status: CaseStatus;
  pausedAt: Date | null;
  pausedReason: string | null;
  jobs: { mode: Mode; status: JobStatus; systemKey: string }[];
};

// Pure per-case decision: not-found/out-of-scope → skip "not found" (an out-of-scope case must read
// as absent, never touched); state-invalid → skip with the validity reason; else run. Tested directly.
export function bulkCaseDecision(action: BulkAction, c: BulkCaseRow | undefined, scope: ClientScope): { run: true } | { run: false; reason: string } {
  if (!c || !scopeAllows(scope, c.clientId)) return { run: false, reason: "not found" };
  const v = caseActionValidity(action, {
    status: c.status,
    paused: c.pausedAt != null,
    scheduled: c.pausedReason === "scheduled",
    hasInflight: c.jobs.some((j) => j.status === "dispatched" || j.status === "running"),
    hasVerifiable: verifiableJobs(c.jobs).length > 0,
  });
  return v.valid ? { run: true } : { run: false, reason: v.reason ?? "invalid" };
}

// The bulk endpoint's body: scope computed ONCE, cases fetched ONCE, then decide + apply per id.
// Out-of-scope/invalid ids are skipped with a reason — a per-id failure never aborts the batch.
export async function runBulkCaseAction(db: PrismaClient, action: BulkAction, ids: string[], user: ActingUser | null | undefined, scope: ClientScope): Promise<BulkResult[]> {
  const rows = await db.caseRequest.findMany({
    where: { id: { in: ids } },
    select: { id: true, clientId: true, status: true, pausedAt: true, pausedReason: true, jobs: { select: { mode: true, status: true, systemKey: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r as BulkCaseRow]));
  const results: BulkResult[] = [];
  for (const id of ids) {
    const d = bulkCaseDecision(action, byId.get(id), scope);
    if (!d.run) { results.push({ id, ok: false, skipped: d.reason }); continue; }
    try {
      const r = await runBulkAction(db, action, id, user);
      results.push(r.ok ? { id, ok: true } : { id, ok: false, skipped: "not found" }); // vanished mid-batch
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
