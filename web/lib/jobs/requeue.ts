// Re-queue a finished job for a FULL re-execution (clear validateOnly + every prior outcome) and
// reopen its case so the claim loop dispatches it. Shared by the run report's re-run button and
// the procurement watcher (PC case resolved -> re-run the license assignment automatically).
import { Prisma, type PrismaClient } from "@prisma/client";
import { carriedRetryMarker, type AutoRetryMarker } from "./auto-retry";
import { resolveActor, type ActorInput } from "../auth/actor";

export async function requeueJob(
  db: PrismaClient,
  jobId: string,
  actor: ActorInput,
  opts: { carryRetryCount?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
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
  // The auto-retry SCHEDULE always goes (the fresh run re-decides whether another wait is needed),
  // but for an automatic retry the ATTEMPT COUNT has to survive the requeue — recordResult reads it
  // back to enforce the attempt cap. Dropping the whole marker here reset the count to 0 on every
  // requeue, so `count < MAX` was always true and a never-syncing user retried every 15 minutes
  // FOREVER (the DB shows count:1 after dozens of retries). An operator-driven re-run deliberately
  // does NOT carry it: a human stepping in starts the budget over.
  const prevRetry = (req.autoRetry ?? null) as AutoRetryMarker | null;
  delete req.autoRetry;
  if (opts.carryRetryCount) {
    const carried = carriedRetryMarker(prevRetry, Date.now());
    if (carried) req.autoRetry = carried;
  }

  await db.job.update({
    where: { id: job.id },
    // Prisma.DbNull actually CLEARS the columns (undefined would leave them unchanged) — so the run
    // report shows a clean slate immediately on re-run instead of the previous run's stale actions.
    data: { status: "pending", assignedAgentId: null, request: req as Prisma.InputJsonValue, result: Prisma.DbNull, validation: Prisma.DbNull, evidence: Prisma.DbNull, progress: Prisma.DbNull, error: null, startedAt: null, finishedAt: null },
  });
  // Reopen the case so the claim loop (which skips failed/completed cases) can dispatch it. Also clear
  // verifiedAt so the auto-verify sweep runs again after this real re-run settles.
  await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: "queued", verifiedAt: null } });
  const who = resolveActor(actor);
  await db.auditLog.create({ data: { actor: who.actor, userId: who.userId, action: "job.rerun", jobId: job.id, caseRequestId: job.caseRequestId } });
  return { ok: true };
}
