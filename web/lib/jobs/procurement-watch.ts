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

export async function sweepProcurementWatches(db: PrismaClient): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  await sweepAutoRetries(db).catch(() => {});

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
