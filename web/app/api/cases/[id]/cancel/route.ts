// POST /api/cases/:id/cancel — stop a running case: abort every in-flight (dispatched/running) step
// and pause the case so no further steps are claimed. Non-destructive (the case stays, restorable to
// running by resuming/re-planning) — distinct from trashing it. Mirrors the per-step Stop, applied to
// the whole case.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { recordAudit, actorLabel } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { id: true, clientId: true } });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Stop every in-flight step (marks it failed; a late runner result is then rejected).
  const inflight = await db.job.findMany({ where: { caseRequestId: params.id, status: { in: ["dispatched", "running"] } }, select: { id: true } });
  const svc = makeRunnerService(db);
  let stopped = 0;
  for (const j of inflight) {
    try { await svc.stopJob(j.id, actorLabel(_g.user, "ui:cancel")); stopped++; } catch { /* already terminal / lost the race — ignore */ }
  }
  // Pause so the remaining pending steps aren't claimed (claim filters pausedAt: null), and clear any
  // pending schedule — a cancel must not leave a schedule that would auto-resume the case.
  await db.caseRequest.update({ where: { id: params.id }, data: { pausedAt: new Date(), pausedReason: "operator", scheduledFor: null, scheduledBy: null } });
  await recordAudit("case.cancel", { user: _g.user, caseRequestId: params.id, clientId: c.clientId, detail: { stopped } });
  return NextResponse.json({ ok: true, stopped });
}
