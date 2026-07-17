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
  // Up to two attempts: the job row races BOTH sweeps (auto-verify resets succeeded -> pending
  // verify the instant a case completes; the failure sweep rolls verify jobs back) and runner
  // claims. When the conditional write misses, re-reading once and re-deciding turns "you lost a
  // benign race" into the right outcome instead of a 409 blaming a runner claim that never happened.
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, mode: true, status: true, caseRequestId: true, request: true } });
    if (!job) return { ok: false, error: "unknown job", status: 404 };
    if (job.mode !== "api") return { ok: false, error: "only automated (api) jobs can be re-run", status: 422 };

    const queuedVerify = job.status === "pending" && Boolean(((job.request ?? {}) as { validateOnly?: unknown }).validateOnly);
    if (job.status === "pending" && !queuedVerify) {
      // Already queued for a FULL run — the exact state a re-queue produces, so this is success,
      // not a refusal. (The mailbox-decision route retries after a conflict; a 409 here made that
      // retry fail forever once the first attempt had already converted the job.) Reopen the case
      // and record the no-op so the trail explains the second click.
      await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: "queued", verifiedAt: null } });
      const who = resolveActor(actor);
      await db.auditLog.create({ data: { actor: who.actor, userId: who.userId, action: "job.rerun", jobId: job.id, caseRequestId: job.caseRequestId, detail: { alreadyQueued: true } } });
      return { ok: true };
    }
    if (!["succeeded", "failed", "skipped"].includes(job.status) && !queuedVerify) {
      // dispatched/running — a runner has it; mutating it mid-flight isn't safe.
      return { ok: false, error: `job is ${job.status}; only a finished job can be re-run`, status: 409 };
    }
    // RACE with the auto-verify sweep: the moment a case completes, the sweep resets its succeeded
    // steps to PENDING validate-only jobs — exactly when an operator is answering a picker (e.g. the
    // mailbox decision) whose answer re-queues those same steps. A queued-but-unclaimed verify pass
    // is safe to convert into the full re-run the operator asked for (the reset below strips
    // validateOnly); refusing it 409'd the answer for no reason.

    // A re-run is a FULL re-execution, not a validate-only pass — clear the validateOnly stamp the
    // auto-verify sweep may have left on the request, or the runner just re-validates and the step's
    // stale actions never refresh. The verify-pass rollback stamps go too (see verifyCase).
    const req = { ...((job.request ?? {}) as Record<string, unknown>) };
    delete req.validateOnly;
    delete req.priorStatus;
    delete req.priorError;
    delete req.priorValidation;
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

    // Conditional on the status we read (optimistic concurrency): a pending verify job can be CLAIMED
    // between the read above and this write — resetting it underneath a runner would double-execute
    // the step. count 0 = it moved; loop back for one fresh read instead of clobbering.
    const updated = await db.job.updateMany({
      where: { id: job.id, status: job.status },
      // Prisma.DbNull actually CLEARS the columns (undefined would leave them unchanged) — so the run
      // report shows a clean slate immediately on re-run instead of the previous run's stale actions.
      data: { status: "pending", assignedAgentId: null, request: req as Prisma.InputJsonValue, result: Prisma.DbNull, validation: Prisma.DbNull, evidence: Prisma.DbNull, progress: Prisma.DbNull, error: null, startedAt: null, finishedAt: null },
    });
    if (updated.count === 0) continue;
    // Reopen the case so the claim loop (which skips failed/completed cases) can dispatch it. Also clear
    // verifiedAt so the auto-verify sweep runs again after this real re-run settles.
    await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: "queued", verifiedAt: null } });
    const who = resolveActor(actor);
    await db.auditLog.create({ data: { actor: who.actor, userId: who.userId, action: "job.rerun", jobId: job.id, caseRequestId: job.caseRequestId } });
    return { ok: true };
  }
  return { ok: false, error: "the job is changing underneath (a verify sweep or a runner claim) — try again", status: 409 };
}
