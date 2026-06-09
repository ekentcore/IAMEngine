// POST /api/jobs/:id/rerun — re-dispatch a finished job (re-run / re-validate from the run
// report). Resets the job to pending and clears its prior outcome; the existing claim loop
// picks it up. The case is nudged off a terminal status so claim doesn't exclude it.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const job = await db.job.findUnique({ where: { id: params.id }, select: { id: true, mode: true, status: true, caseRequestId: true, request: true } });
  if (!job) return NextResponse.json({ error: "unknown job" }, { status: 404 });
  if (job.mode !== "api") return NextResponse.json({ error: "only automated (api) jobs can be re-run" }, { status: 422 });
  if (!["succeeded", "failed", "skipped"].includes(job.status)) {
    return NextResponse.json({ error: `job is ${job.status}; only a finished job can be re-run` }, { status: 409 });
  }

  // A manual re-run is a FULL re-execution, not a validate-only pass — clear the validateOnly stamp the
  // auto-verify sweep may have left on the request, or the runner just re-validates and the step's
  // stale actions never refresh.
  const req = { ...((job.request ?? {}) as Record<string, unknown>) };
  delete req.validateOnly;

  await db.job.update({
    where: { id: job.id },
    data: { status: "pending", assignedAgentId: null, request: req as Prisma.InputJsonValue, result: undefined, validation: undefined, evidence: undefined, progress: Prisma.DbNull, error: null, startedAt: null, finishedAt: null },
  });
  // Reopen the case so the claim loop (which skips failed/completed cases) can dispatch it. Also clear
  // verifiedAt so the auto-verify sweep runs again after this real re-run settles.
  await db.caseRequest.update({ where: { id: job.caseRequestId }, data: { status: "queued", verifiedAt: null } });
  await db.auditLog.create({ data: { actor: "ui", action: "job.rerun", jobId: job.id, caseRequestId: job.caseRequestId } });

  return NextResponse.json({ ok: true, jobId: job.id });
}
