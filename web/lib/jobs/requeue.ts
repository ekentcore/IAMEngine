// Re-queue a finished job for a FULL re-execution (clear validateOnly + every prior outcome) and
// reopen its case so the claim loop dispatches it. Shared by the run report's re-run button and
// the procurement watcher (PC case resolved -> re-run the license assignment automatically).
import { Prisma, type PrismaClient } from "@prisma/client";

export async function requeueJob(db: PrismaClient, jobId: string, actor: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, mode: true, status: true, caseRequestId: true, request: true } });
  if (!job) return { ok: false, error: "unknown job", status: 404 };
  if (job.mode !== "api") return { ok: false, error: "only automated (api) jobs can be re-run", status: 422 };
  if (!["succeeded", "failed", "skipped"].includes(job.status)) {
    return { ok: false, error: `job is ${job.status}; only a finished job can be re-run`, status: 409 };
  }

  // A re-run is a FULL re-execution, not a validate-only pass — clear the validateOnly stamp the
  // auto-verify sweep may have left on the request, or the runner just re-validates and the step's
  // stale actions never refresh.
  const req = { ...((job.request ?? {}) as Record<string, unknown>) };
  delete req.validateOnly;

  await db.job.update({
    where: { id: job.id },
    // Prisma.DbNull actually CLEARS the columns (undefined would leave them unchanged) — so the run
    // report shows a clean slate immediately on re-run instead of the previous run's stale actions.
    data: { status: "pending", assignedAgentId: null, request: req as Prisma.InputJsonValue, result: Prisma.DbNull, validation: Prisma.DbNull, evidence: Prisma.DbNull, progress: Prisma.DbNull, error: null, startedAt: null, finishedAt: null },
  });
  // Reopen the case so the claim loop (which skips failed/completed cases) can dispatch it. Also clear
  // verifiedAt so the auto-verify sweep runs again after this real re-run settles.
  await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: "queued", verifiedAt: null } });
  await db.auditLog.create({ data: { actor, action: "job.rerun", jobId: job.id, caseRequestId: job.caseRequestId } });
  return { ok: true };
}
