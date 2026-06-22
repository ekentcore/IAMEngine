// POST /api/cases/:id/pause { paused: boolean } — operator pause/resume. A paused case's jobs are
// never claimed by runners (claim filters pausedAt: null), so systems can be adjusted / the case
// re-planned mid-run without a runner grabbing the next step.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { paused?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const paused = Boolean(body.paused);
  const c = await db.caseRequest.findUnique({ where: { id: params.id }, select: { id: true, clientId: true } });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Keep pausedReason in lockstep with pausedAt: a manual pause is "operator"; resuming clears the
  // reason (so a scheduled/needs-info hold that's resumed doesn't leave a stale reason behind).
  await db.caseRequest.update({ where: { id: params.id }, data: { pausedAt: paused ? new Date() : null, pausedReason: paused ? "operator" : null } });
  await db.auditLog.create({ data: { actor: "ui", action: paused ? "case.pause" : "case.resume", caseRequestId: params.id, clientId: c.clientId } });
  return NextResponse.json({ ok: true, paused });
}
