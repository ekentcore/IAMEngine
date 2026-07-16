// POST /api/audits/:kind — start a fleet sweep ("permissions" | "leaked_seats").
// GET  /api/audits/:kind — the latest run's state, for the page's progress poll.
//
// The sweep reads every client's M365 credential, so it is gated on the same permission as wiring one
// (client.edit_secrets) and audited. It returns run STATE only — the findings are read by the page.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { auditActor } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { startRun, latestRun, isAuditKind } from "@/lib/audits/audit-runs";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { kind: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  if (!isAuditKind(params.kind)) return NextResponse.json({ error: "unknown audit kind" }, { status: 404 });

  const who = auditActor(_g.user, "ui");
  const r = await startRun(db, params.kind, who.label);
  // Not an error: someone else's scan is already doing the work, so point at it rather than start a
  // second one burning the same Graph quota.
  if (!r.started) return NextResponse.json({ started: false, reason: r.reason, id: r.id }, { status: 409 });

  await db.auditLog.create({
    data: { actor: who.label, userId: who.userId, action: "audit.m365.scan", detail: { kind: params.kind, runId: r.id } },
  }).catch(() => {}); // an audit-log failure must never lose the scan
  return NextResponse.json({ started: true, id: r.id });
}

export async function GET(_req: Request, { params }: { params: { kind: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  if (!isAuditKind(params.kind)) return NextResponse.json({ error: "unknown audit kind" }, { status: 404 });
  const run = await latestRun(db, params.kind);
  if (!run) return NextResponse.json({ run: null });
  // State only — never the findings; the page reads those server-side, client-scoped.
  return NextResponse.json({
    run: { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, scanned: run.scanned, total: run.total, error: run.error },
  });
}
