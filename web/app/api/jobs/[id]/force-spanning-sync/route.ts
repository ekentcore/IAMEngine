// POST /api/jobs/:id/force-spanning-sync — "Force Spanning sync" on a case's Spanning line: dispatch a
// single ad-hoc browser-automation job that drives the Spanning admin portal to trigger a directory/
// user scan, so Spanning discovers a just-created M365 user NOW instead of on its own schedule (the
// Spanning API has no sync endpoint). Rides the Spanning line's brokered secret + config; singleRun,
// so it's claimable on a completed/paused case and never cascades into the case status. Only agents
// that report the "browser" capability (Node/Playwright installed) can claim it.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { SPANNING_FORCE_SYNC_KEY } from "@/lib/jobs/adhoc";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const src = await db.job.findUnique({
    where: { id: params.id },
    select: { systemKey: true, caseRequestId: true, request: true, case: { select: { clientId: true, deletedAt: true, dryRun: true } } },
  });
  if (!src || src.case.deletedAt) return NextResponse.json({ error: "not found" }, { status: 404 });
  // The source must be the Spanning line — that's whose brokered secret + config the sync rides.
  if (src.systemKey !== "spanning") return NextResponse.json({ error: `force sync is only available on the Spanning line (got ${src.systemKey})` }, { status: 422 });
  // Dry-run is authoritative at claim time: the browser flow would run against the LIVE portal (there
  // is no -WhatIf for a real login), so refuse rather than half-act.
  if (src.case.dryRun) return NextResponse.json({ error: "this case is in dry-run mode — turn off dry run before forcing a live Spanning sync" }, { status: 409 });

  // One at a time per case: reuse an in-flight force-sync instead of stacking a second portal login.
  const inflight = await db.job.findFirst({
    where: { caseRequestId: src.caseRequestId, systemKey: SPANNING_FORCE_SYNC_KEY, status: { in: ["pending", "dispatched", "running"] } },
    select: { id: true },
  });
  if (inflight) return NextResponse.json({ ok: true, jobId: inflight.id, reused: true });

  // Ride the Spanning line's request (secretNames + config) so credential brokering + tenant/identity
  // config just work. No cascade: singleRun + its own dependsOn:[] so it can run on a finished case.
  const srcReq = (src.request ?? {}) as Record<string, unknown>;
  const config = (srcReq.config ?? {}) as Record<string, unknown>;
  const agg = await db.job.aggregate({ where: { caseRequestId: src.caseRequestId }, _max: { sequence: true } });
  const job = await db.job.create({
    data: {
      caseRequestId: src.caseRequestId, systemKey: SPANNING_FORCE_SYNC_KEY, mode: "api", sequence: (agg._max.sequence ?? 0) + 1,
      status: "pending", singleRun: true,
      request: { secretNames: srcReq.secretNames ?? [], config, dependsOn: [], requiresApproval: false, captureEvidence: false } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  await recordAudit("spanning.forcesync.dispatch", { user: _g.user, jobId: job.id, caseRequestId: src.caseRequestId, clientId: src.case.clientId, detail: { fromLine: src.systemKey } });
  return NextResponse.json({ ok: true, jobId: job.id });
}
