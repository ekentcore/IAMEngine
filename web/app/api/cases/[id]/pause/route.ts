// POST /api/cases/:id/pause { paused: boolean } — operator pause/resume. A paused case's jobs are
// never claimed by runners (claim filters pausedAt: null), so systems can be adjusted / the case
// re-planned mid-run without a runner grabbing the next step.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
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
  // EITHER direction cancels a pending schedule: a manual Pause is an explicit stop that must
  // override the schedule (else the sweep would auto-run it anyway), and a manual Resume runs it now
  // so a later auto-resume would be meaningless. Clearing scheduledFor unconditionally is the
  // operator taking manual control.
  await db.caseRequest.update({
    where: { id: params.id },
    data: { pausedAt: paused ? new Date() : null, pausedReason: paused ? "operator" : null, scheduledFor: null, scheduledBy: null },
  });
  // Record WHO paused/resumed (the cases list shows "Paused: <name>" / "Unpaused: <name>").
  await recordAudit(paused ? "case.pause" : "case.resume", { user: _g.user, caseRequestId: params.id, clientId: c.clientId });
  return NextResponse.json({ ok: true, paused });
}
