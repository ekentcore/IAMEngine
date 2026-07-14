// POST /api/cases/:id/complete — operator confirms a case is done (typically because the ServiceNow
// scan found its ticket resolved/closed; the work happened outside the app). Marks every unfinished
// step succeeded via manualCompletionFlip — which records priorStatus/priorError, so the per-step
// mark-complete toggle can restore each step exactly — then recomputes the case status
// (deriveCaseStatus ⇒ completed). Nothing is dispatched or executed here: an approval-gated step
// flipped this way was never run by the app, and its prior status stays in the result + audit trail.
// Refuses while a runner is mid-execution; each flip is status-guarded inside the transaction, so a
// job claimed in the read→write window rolls the whole completion back (409) instead of being
// clobbered. Idempotent on an already-completed case.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { deriveCaseStatus } from "@/lib/jobs/runner-logic";
import { manualCompletionFlip, planCompletion } from "@/lib/cases/sn-completion";

export const dynamic = "force-dynamic";

const IN_FLIGHT = "a step is currently running — wait for it to finish, then rescan";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { snState?: unknown };
  const snState = typeof body.snState === "string" ? body.snState : null;

  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: {
      id: true, status: true, deletedAt: true, clientId: true, serviceNowCaseNumber: true,
      jobs: { select: { id: true, systemKey: true, status: true, result: true, error: true } },
    },
  });
  if (!c || c.deletedAt) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (c.status === "completed") return NextResponse.json({ ok: true, alreadyCompleted: true, stepsMarked: 0 });

  const plan = planCompletion(c.jobs);
  if (!plan.ok) return NextResponse.json({ error: IN_FLIGHT }, { status: 409 });

  const now = new Date();
  let caseStatus: string;
  try {
    caseStatus = await db.$transaction(async (tx) => {
      for (const j of plan.flip) {
        // Guarded on the status we planned against: a job a runner claimed since the read no longer
        // matches, the count comes back 0, and the throw rolls back every flip.
        const r = await tx.job.updateMany({ where: { id: j.id, status: j.status }, data: manualCompletionFlip(j, now) });
        if (r.count === 0) throw new Error("in_flight");
      }
      const jobs = await tx.job.findMany({
        where: { caseRequestId: c.id },
        select: { id: true, systemKey: true, sequence: true, mode: true, status: true, request: true },
      });
      // A failure the operator ACCEPTED ("ignore") must not re-fail the case here — confirm-complete on
      // a case with an accepted failure would otherwise drag it straight back to "failed".
      const acceptedKeys = new Set(
        (await tx.runOutcome.findMany({
          where: { caseRequestId: c.id, status: "failed", resolvedAt: { not: null } },
          select: { systemKey: true },
        })).map((o) => o.systemKey)
      );
      const derived = deriveCaseStatus(
        jobs.map((j) => {
          const r = (j.request ?? {}) as { requiresApproval?: boolean; approved?: boolean };
          return {
            id: j.id, systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, status: j.status,
            requiresApproval: Boolean(r.requiresApproval), approved: Boolean(r.approved),
            accepted: j.status === "failed" && acceptedKeys.has(j.systemKey),
          };
        })
      );
      await tx.caseRequest.update({ where: { id: c.id }, data: { status: derived } });
      return derived;
    });
  } catch (e) {
    if (e instanceof Error && e.message === "in_flight") return NextResponse.json({ error: IN_FLIGHT }, { status: 409 });
    throw e;
  }

  await recordAudit("case.complete", {
    user: _g.user,
    clientId: c.clientId,
    caseRequestId: c.id,
    detail: {
      source: snState ? "servicenow-scan" : "manual",
      caseNumber: c.serviceNowCaseNumber,
      snState,
      caseStatus,
      steps: plan.flip.map((j) => ({ id: j.id, systemKey: j.systemKey, from: j.status })),
    },
  });

  return NextResponse.json({ ok: true, stepsMarked: plan.flip.length, caseStatus });
}
