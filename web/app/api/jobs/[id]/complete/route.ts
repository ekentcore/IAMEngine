// POST /api/jobs/{id}/complete — { done: boolean }. Operator marks a MANUAL or SKIPPED step as
// done (or unmarks it), so a case whose only remaining work is manual/checklist can reach
// "completed". Marking sets the job succeeded (flagged manualCompletion so it can be undone);
// unmarking restores the step's recorded prior state (incl. a failed step's error text — steps
// force-completed by the whole-case complete route land back on failed/pending, not "skipped"),
// falling back to the mode's natural state for rows flagged before priorStatus existed.
// Recomputes the case status afterward.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { deriveCaseStatus } from "@/lib/jobs/runner-logic";
import { manualCompletionFlip } from "@/lib/cases/sn-completion";

const RESTORABLE = ["pending", "manual", "skipped", "failed"] as const;

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { done?: unknown };
  const done = body.done !== false; // default: mark complete

  const job = await db.job.findUnique({
    where: { id: params.id },
    select: { id: true, mode: true, status: true, caseRequestId: true, result: true, error: true },
  });
  if (!job) return NextResponse.json({ error: "unknown job" }, { status: 404 });

  const result = (job.result ?? {}) as Record<string, unknown>;

  if (done) {
    if (!["manual", "skipped"].includes(job.status)) {
      return NextResponse.json({ error: `only a manual or skipped step can be marked complete (this one is ${job.status})` }, { status: 409 });
    }
    await db.job.update({ where: { id: job.id }, data: manualCompletionFlip(job, new Date()) });
  } else {
    if (!result.manualCompletion) {
      return NextResponse.json({ error: "only a manually-completed step can be unmarked" }, { status: 409 });
    }
    const revert = (RESTORABLE as readonly string[]).includes(result.priorStatus as string)
      ? (result.priorStatus as (typeof RESTORABLE)[number])
      : job.mode === "manual" ? "manual" : "skipped";
    const priorError = typeof result.priorError === "string" ? result.priorError : null;
    const rest = { ...result };
    delete rest.manualCompletion;
    delete rest.priorStatus;
    delete rest.priorError;
    await db.job.update({
      where: { id: job.id },
      data: { status: revert, result: Object.keys(rest).length ? (rest as Prisma.InputJsonValue) : Prisma.DbNull, error: priorError, finishedAt: null },
    });
  }

  // Recompute the case status now that a step changed terminal state.
  const caseJobs = await db.job.findMany({
    where: { caseRequestId: job.caseRequestId },
    select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true },
  });
  const derived = deriveCaseStatus(
    caseJobs.map((j) => {
      const r = (j.request ?? {}) as { requiresApproval?: boolean; approved?: boolean };
      return { id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status, requiresApproval: Boolean(r.requiresApproval), approved: Boolean(r.approved) };
    })
  );
  // deriveCaseStatus never returns "queued"/"planning"; don't promote a not-yet-started case to
  // "running" just because an operator closed a manual step before any runner has claimed work.
  const current = await db.caseRequest.findUnique({ where: { id: job.caseRequestId }, select: { status: true } });
  const anyStarted = caseJobs.some((j) => j.status === "dispatched" || j.status === "running");
  const caseStatus =
    derived === "running" && !anyStarted && (current?.status === "queued" || current?.status === "planning")
      ? current!.status
      : derived;
  await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: caseStatus } });
  await db.auditLog.create({ data: { actor: "ui", action: done ? "job.mark_complete" : "job.unmark_complete", jobId: job.id, caseRequestId: job.caseRequestId } });

  return NextResponse.json({ ok: true, caseStatus });
}
