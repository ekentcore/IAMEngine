// POST /api/cases/:id/complete — operator confirms a case is done (typically because the ServiceNow
// scan found its ticket resolved/closed). Marks every unfinished step succeeded — flagged
// manualCompletion, so each one is individually undoable via the step's mark-complete toggle —
// then moves the case to completed. Refuses while a runner is mid-execution (same in-flight rule
// as trashing). Idempotent on an already-completed case.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { planCompletion } from "@/lib/cases/sn-completion";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { snState?: unknown };
  const snState = typeof body.snState === "string" ? body.snState : null;

  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: {
      id: true, status: true, deletedAt: true, clientId: true, serviceNowCaseNumber: true,
      jobs: { select: { id: true, status: true, result: true } },
    },
  });
  if (!c || c.deletedAt) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (c.status === "completed") return NextResponse.json({ ok: true, alreadyCompleted: true, stepsMarked: 0 });

  const plan = planCompletion(c.jobs);
  if (!plan.ok) {
    return NextResponse.json({ error: "a step is currently running — wait for it to finish, then rescan" }, { status: 409 });
  }

  const now = new Date();
  const flipIds = new Set(plan.flipIds);
  await db.$transaction([
    ...c.jobs
      .filter((j) => flipIds.has(j.id))
      .map((j) =>
        db.job.update({
          where: { id: j.id },
          data: {
            status: "succeeded",
            result: { ...((j.result ?? {}) as Record<string, unknown>), manualCompletion: true } as Prisma.InputJsonValue,
            error: null,
            finishedAt: now,
          },
        })
      ),
    // Every job is now succeeded/skipped, so deriveCaseStatus would say "completed" — set it directly.
    db.caseRequest.update({ where: { id: c.id }, data: { status: "completed" } }),
  ]);

  await recordAudit("case.complete", {
    user: _g.user,
    clientId: c.clientId,
    caseRequestId: c.id,
    detail: {
      source: snState ? "servicenow-scan" : "manual",
      caseNumber: c.serviceNowCaseNumber,
      snState,
      stepsMarked: plan.flipIds.length,
    },
  });

  return NextResponse.json({ ok: true, stepsMarked: plan.flipIds.length });
}
