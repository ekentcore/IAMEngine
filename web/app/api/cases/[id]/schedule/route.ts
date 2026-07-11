// POST /api/cases/:id/schedule { at: ISO | null } — schedule the case to start (auto-resume) at a
// time. Setting a time also HOLDS the case (reason "scheduled") if it isn't already held, so runners
// don't claim it before the schedule fires; the heartbeat sweep (sweepScheduledCases) releases the
// hold when the time arrives. { at: null } clears the schedule but leaves any hold in place.
// Dry-run cases may be scheduled — the auto-resume mirrors a manual Resume, and their jobs run -WhatIf.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const MAX_AHEAD_MS = 366 * 24 * 3600_000; // ≤ 1 year out — beyond that it's almost certainly a typo

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { at?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: { id: true, clientId: true, status: true, deletedAt: true, pausedReason: true, scheduledFor: true },
  });
  if (!c || c.deletedAt) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.at === null) {
    await db.caseRequest.update({ where: { id: c.id }, data: { scheduledFor: null, scheduledBy: null } });
    await recordAudit("case.schedule.cleared", { user: _g.user, caseRequestId: c.id, clientId: c.clientId, detail: { was: c.scheduledFor?.toISOString() ?? null } });
    return NextResponse.json({ ok: true, scheduledFor: null });
  }

  if (typeof body.at !== "string") return NextResponse.json({ error: "at must be an ISO datetime string or null" }, { status: 422 });
  const at = new Date(body.at);
  if (Number.isNaN(at.getTime())) return NextResponse.json({ error: "at is not a valid datetime" }, { status: 422 });
  const now = Date.now();
  if (at.getTime() <= now) return NextResponse.json({ error: "the scheduled time must be in the future" }, { status: 422 });
  if (at.getTime() > now + MAX_AHEAD_MS) return NextResponse.json({ error: "the scheduled time must be within a year" }, { status: 422 });
  if (["completed", "failed"].includes(c.status)) return NextResponse.json({ error: `a ${c.status} case can't be scheduled` }, { status: 409 });
  // A case gated on missing intake data or credentials is NOT ready to run — refuse to schedule it
  // (auto-running it later would provision with blank/"Unknown" values or fail on missing creds).
  // Resolve the gate first, then schedule.
  if (c.pausedReason === "needs_info") return NextResponse.json({ error: "fill in the required intake fields before scheduling this case" }, { status: 409 });
  if (c.pausedReason === "creds") return NextResponse.json({ error: "wire the missing credentials before scheduling this case" }, { status: 409 });

  await db.caseRequest.update({
    where: { id: c.id },
    data: {
      scheduledFor: at,
      scheduledBy: _g.user && !_g.user.system ? _g.user.email : null,
      // Hold the case as "scheduled" so runners don't claim it before the time fires. This CONVERTS a
      // benign existing hold (review / operator / already-scheduled) to "scheduled" — the operator
      // choosing a run time is the decision to run it — and the sweep only releases "scheduled" holds.
      pausedAt: new Date(),
      pausedReason: "scheduled",
    },
  });
  await recordAudit("case.schedule.set", { user: _g.user, caseRequestId: c.id, clientId: c.clientId, detail: { at: at.toISOString() } });
  return NextResponse.json({ ok: true, scheduledFor: at.toISOString() });
}
