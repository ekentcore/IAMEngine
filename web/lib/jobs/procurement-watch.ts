// Procurement-case watcher: a job that couldn't finish for lack of license seats gets a WARN +
// "open a Procurement Case". The operator records the PC number on the step; this sweep (driven
// by runner heartbeats — no cron infra) checks each watched PC's state in ServiceNow every
// CHECK_EVERY_MS, and when the PC resolves it RE-QUEUES the job: the (idempotent) executor
// re-runs the assignment, validation reads it back, and the auto-verify pass clears the warning —
// no human in the loop after the PC closes. A cancelled PC stops the watch without re-running.
// The "Check now" button calls checkProcurementWatch directly, skipping the interval.
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { fetchTaskState, classifyTaskState } from "@/lib/servicenow/task-state";
import { getAppSetting } from "@/lib/settings";
import { AUTO_FIX_SETTING_KEY, type AutoFixSetting, createFixTask } from "@/lib/fixes/fix-tasks";
import { getDefaultProvider } from "@/lib/fixes/providers";
import { requeueJob } from "./requeue";

const CHECK_EVERY_MS = 5 * 60_000;
const BATCH = 10; // per sweep — heartbeats are frequent, so backlog drains quickly

// Heartbeats arrive every few seconds from every runner; only hit the DB when a sweep could
// actually be due. In-process throttle, not a lock — a second instance just re-checks, and the
// per-watch lastCheckedAt claim below keeps the SN calls deduplicated.
let lastSweepAt = 0;

// Check ONE watch against ServiceNow right now and apply the outcome (note update, cancel, or
// requeue-the-job-on-resolve). The caller has already claimed the watch (bumped lastCheckedAt).
// Never throws — a transient SN failure leaves the watch watching with the error in its note.
export async function checkProcurementWatch(
  db: PrismaClient,
  w: { id: string; jobId: string; number: string }
): Promise<void> {
  const cfg = snConfigFromEnv();
  try {
    const task = await fetchTaskState(cfg, w.number);
    if (!task) {
      await db.procurementWatch.update({ where: { id: w.id }, data: { note: "not found in ServiceNow" } });
      return;
    }
    const cls = classifyTaskState(task.state);
    if (cls === "open") {
      await db.procurementWatch.update({ where: { id: w.id }, data: { note: task.state } });
      return;
    }
    if (cls === "cancelled") {
      await db.procurementWatch.update({ where: { id: w.id }, data: { state: "cancelled", note: task.state } });
      await db.auditLog.create({ data: { actor: "system:procurement-watch", action: "procurement.cancelled", jobId: w.jobId, detail: { number: w.number, snState: task.state } } });
      return;
    }
    // done -> re-run the blocked job; the executor is idempotent and now has seats to assign.
    const out = await requeueJob(db, w.jobId, "system:procurement-watch");
    if (!out.ok && out.status === 409) {
      // The job is mid-flight right now (operator re-run / validate pass). That's TRANSIENT —
      // keep watching so the next interval retries the requeue once the job settles.
      await db.procurementWatch.update({ where: { id: w.id }, data: { note: `${task.state} — job busy, will retry` } });
      return;
    }
    await db.procurementWatch.update({
      where: { id: w.id },
      data: { state: out.ok ? "resolved" : "error", note: out.ok ? `${task.state} — job re-queued` : `${task.state} — requeue failed: ${out.error}` },
    });
    await db.auditLog.create({ data: { actor: "system:procurement-watch", action: out.ok ? "procurement.resolved.requeued" : "procurement.requeue.failed", jobId: w.jobId, detail: { number: w.number, snState: task.state } } });
  } catch (e) {
    // Transient SN failure: leave state=watching; the next interval (or Check now) retries.
    await db.procurementWatch.update({ where: { id: w.id }, data: { note: `check failed: ${(e as Error).message}` } }).catch(() => {});
  }
}

// Re-queue succeeded jobs whose self-scheduled retry (request.autoRetry.at) is due — e.g. a
// Spanning/Mimecast step waiting for the vendor's directory sync to discover a new user. The
// requeue clears the marker; the re-run either finishes the work or schedules the next wait.
export async function sweepAutoRetries(db: PrismaClient): Promise<void> {
  const due = await db.job.findMany({
    where: { status: "succeeded", mode: "api", request: { path: ["autoRetry", "at"], lt: Date.now() } },
    take: 10,
    select: { id: true },
  });
  for (const j of due) {
    const out = await requeueJob(db, j.id, "system:auto-retry");
    if (!out.ok) continue; // mid-flight (operator re-ran) — the fresh run re-decides anyway
    await db.auditLog.create({ data: { actor: "system:auto-retry", action: "job.autoretry.requeued", jobId: j.id } });
  }
}

// Release cases whose scheduled start (CaseRequest.scheduledFor) has arrived: clear the hold and
// the schedule — runners then claim the pending jobs exactly as after a manual Resume (which also
// does nothing beyond unpausing). The conditional updateMany doubles as the claim: two concurrent
// sweeps can't both fire (the second one matches zero rows), and a case the operator resumed or
// trashed in between is skipped.
export async function sweepScheduledCases(db: PrismaClient): Promise<void> {
  // ONLY auto-release holds whose reason is "scheduled". A case that's since been paused by an
  // operator (reason "operator"), cancelled, or gated on missing intake ("needs_info") / credentials
  // ("creds") must NOT be auto-run — the schedule route refuses to schedule those hard gates, and this
  // reason filter is the safety net if a case regresses into one after it was scheduled.
  const due = await db.caseRequest.findMany({
    where: { scheduledFor: { lte: new Date() }, deletedAt: null, pausedReason: "scheduled", status: { notIn: ["failed", "completed"] } },
    take: 10,
    select: { id: true, clientId: true, scheduledFor: true },
  });
  for (const c of due) {
    const claimed = await db.caseRequest.updateMany({
      where: { id: c.id, scheduledFor: c.scheduledFor, pausedReason: "scheduled", deletedAt: null },
      data: { pausedAt: null, pausedReason: null, scheduledFor: null, scheduledBy: null },
    });
    if (claimed.count === 0) continue;
    await db.auditLog.create({
      data: { actor: "system:schedule", action: "case.schedule.resumed", caseRequestId: c.id, clientId: c.clientId, detail: { scheduledFor: c.scheduledFor?.toISOString() } },
    }).catch(() => {});
  }
}

// Auto-trigger for the self-healing fix lane (OPT-IN via the "autoFix" app setting; default OFF).
// A failure that keeps recurring — the SAME fingerprint, unresolved, ≥3 occurrences — is handed to
// the analyze worker (LLM tool-calling session → a fix PROPOSAL an operator reviews on /runs; the
// eventual PR is a draft a human merges). Rate-limited to ONE new task per sweep, and a
// fingerprint that EVER had a FixTask is never re-queued automatically (no retry loops; an
// operator can still trigger it by hand from /runs).
export async function sweepAutoFix(db: PrismaClient): Promise<void> {
  const setting = await getAppSetting<AutoFixSetting>(db, AUTO_FIX_SETTING_KEY);
  if (!setting?.enabled) return;
  // No provider registered → nothing to analyze with; skip quietly (rather than one audit row per
  // sweep) — the Settings page is where this gets fixed.
  if (!(await getDefaultProvider(db))) return;

  // Recurring unresolved failures, worst first. Legacy rows without a fingerprint can't be tracked.
  const groups = await db.runOutcome.groupBy({
    by: ["fingerprint"],
    where: { verdict: "failed", resolvedAt: null, fingerprint: { not: "" } },
    _count: { _all: true },
    having: { fingerprint: { _count: { gte: 3 } } },
    orderBy: { _count: { fingerprint: "desc" } },
    take: 20,
  });
  if (groups.length === 0) return;

  const seen = await db.fixTask.findMany({
    where: { fingerprint: { in: groups.map((g) => g.fingerprint) } },
    select: { fingerprint: true },
    distinct: ["fingerprint"],
  });
  const seenFps = new Set(seen.map((t) => t.fingerprint));
  const candidate = groups.find((g) => !seenFps.has(g.fingerprint));
  if (!candidate) return;

  // Latest occurrence supplies the human-readable title + the error context handed to Claude.
  const row = await db.runOutcome.findFirst({ where: { fingerprint: candidate.fingerprint }, orderBy: { at: "desc" } });
  if (!row) return;
  const firstLine = (row.messages[0] ?? row.error ?? "run failed").split("\n")[0];
  const context = [`${row.systemKey} (${row.caseNumber})`, ...row.messages, ...(row.error && !row.messages.includes(row.error) ? [row.error] : [])].filter(Boolean).join("\n");

  const out = await createFixTask(db, {
    fingerprint: candidate.fingerprint,
    title: `${row.systemKey}: ${firstLine}`.slice(0, 300),
    context: context.slice(0, 20000),
    requestedBy: "system:auto-fix",
  });
  await db.auditLog.create({
    data: {
      actor: "system:auto-fix",
      action: out.ok ? "fixtask.create" : "fixtask.create.failed",
      clientId: row.clientId,
      caseRequestId: row.caseRequestId,
      detail: { fingerprint: candidate.fingerprint, systemKey: row.systemKey, occurrences: candidate._count._all, ...(out.ok ? { id: out.task.id } : { error: out.error }) },
    },
  }).catch(() => {});
}

export async function sweepProcurementWatches(db: PrismaClient): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  await sweepAutoRetries(db).catch(() => {});
  await sweepScheduledCases(db).catch(() => {});
  await sweepAutoFix(db).catch(() => {});

  const due = await db.procurementWatch.findMany({
    where: {
      state: "watching",
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now - CHECK_EVERY_MS) } }],
    },
    take: BATCH,
    select: { id: true, jobId: true, number: true, lastCheckedAt: true },
  });

  for (const w of due) {
    // Claim by bumping lastCheckedAt FIRST (conditional on the old value) so two concurrent sweeps
    // can't both query SN / requeue for the same watch.
    const claimed = await db.procurementWatch.updateMany({
      where: { id: w.id, state: "watching", lastCheckedAt: w.lastCheckedAt },
      data: { lastCheckedAt: new Date() },
    });
    if (claimed.count === 0) continue;
    await checkProcurementWatch(db, w);
  }
}
