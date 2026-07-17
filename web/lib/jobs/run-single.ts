// "Run this step only": reset ONE job for a fresh run and pause the case so nothing else
// flows. The job is flagged singleRun so claim() will dispatch it despite the pause and the
// dependency gate; recordResult() records its outcome WITHOUT cascading. The operator hits
// Resume to continue the normal run afterward.
import { Prisma, type PrismaClient } from "@prisma/client";
import { blockingJobs, type JobLite } from "./runner-logic";
import { acceptedKeysFor } from "./runner-service";
import { resolveActor, type ActorInput } from "../auth/actor";

type Result =
  | { ok: true; paused: boolean }
  | { ok: false; error: string; status: number; blockedBy?: Array<{ systemKey: string; status: string }> };

const reqOf = (j: { request: unknown }) => (j.request ?? {}) as Record<string, unknown>;

function lite(
  j: { id: string; systemKey: string; sequence: number; mode: JobLite["mode"]; status: JobLite["status"]; request: unknown },
  acceptedKeys?: Set<string>
): JobLite {
  const r = reqOf(j) as { requiresApproval?: boolean; approved?: boolean; dependsOn?: unknown };
  const deps = Array.isArray(r.dependsOn) ? (r.dependsOn as unknown[]).filter((d): d is string => typeof d === "string") : null;
  return {
    id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status,
    requiresApproval: Boolean(r.requiresApproval), approved: Boolean(r.approved), dependsOn: deps,
    // A failed dependency the operator ACCEPTED satisfies the gate — same overlay the claim gate
    // applies (acceptedKeysFor). Without it, "run this step only" kept 409ing on a failure a human
    // had already resolved, diverging from what the runner itself would do.
    accepted: j.status === "failed" && (acceptedKeys?.has(j.systemKey) ?? false),
  };
}

const TERMINAL = ["completed", "failed"];

export async function runSingleStep(
  db: PrismaClient,
  jobId: string,
  actor: ActorInput,
  force: boolean
): Promise<Result> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { id: true, mode: true, status: true, systemKey: true, sequence: true, request: true, caseRequestId: true,
      case: { select: { status: true, pausedAt: true } } },
  });
  if (!job) return { ok: false, error: "unknown job", status: 404 };
  if (job.mode !== "api") return { ok: false, error: "only automated (api) steps can be run by a runner", status: 422 };

  // Dependency warning: surface unmet prerequisites so the operator can confirm. Bypassed on force.
  if (!force) {
    const [caseJobs, accepted] = await Promise.all([
      db.job.findMany({
        where: { caseRequestId: job.caseRequestId },
        select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true },
      }),
      acceptedKeysFor(db, job.caseRequestId),
    ]);
    const blocking = blockingJobs(lite(job, accepted), caseJobs.map((j) => lite(j, accepted)));
    if (blocking.length > 0) {
      return { ok: false, status: 409, error: "unmet dependencies",
        blockedBy: blocking.map((b) => ({ systemKey: b.systemKey, status: b.status })) };
    }
  }

  // Pause the case so the rest of the run can't cascade while/after this one step runs. Only an
  // active (non-terminal, not-already-paused) case needs it; a completed/failed case has no pending
  // siblings to cascade, so we leave its status untouched.
  let paused = false;
  if (!job.case.pausedAt && !TERMINAL.includes(job.case.status)) {
    await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { pausedAt: new Date(), pausedReason: "single-step" } });
    paused = true;
  }

  // Reset the job for a clean isolated run (mirror requeue, but flag singleRun and DON'T reopen the
  // case to "queued" — it must stay paused).
  const r = { ...reqOf(job) };
  delete r.validateOnly; // full run, not a verify-only pass
  delete r.priorStatus; // verify-pass rollback stamps (see verifyCase) — meaningless on a full re-run
  delete r.priorError;
  delete r.priorValidation;
  delete r.autoRetry;
  // Conditional on the status we read (same optimistic guard as requeueJob): a pending job can be
  // CLAIMED between the read and this write, and an unconditional reset would hand a second runner a
  // singleRun copy while the first is still executing — the step runs twice, concurrently.
  const updated = await db.job.updateMany({
    where: { id: job.id, status: job.status },
    data: {
      status: "pending", singleRun: true, assignedAgentId: null, request: r as Prisma.InputJsonValue,
      result: Prisma.DbNull, validation: Prisma.DbNull, evidence: Prisma.DbNull, progress: Prisma.DbNull,
      error: null, startedAt: null, finishedAt: null,
    },
  });
  if (updated.count === 0) {
    return { ok: false, error: "the job changed while resetting it (a runner may have just claimed it) — reload and try again", status: 409 };
  }
  const who = resolveActor(actor);
  await db.auditLog.create({ data: { actor: who.actor, userId: who.userId, action: "job.run_single", jobId: job.id, caseRequestId: job.caseRequestId, detail: { systemKey: job.systemKey, forced: force, pausedCase: paused } } });
  return { ok: true, paused };
}
