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
import { wiredOptionalSecrets } from "@/lib/secrets/auxiliary";
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

  // ONE force-sync job per case — never a growing stack of them. A prior implementation created a new
  // job (sequence = max+1) on every trigger, so a case ended up with a "spanning-force-sync" step for
  // each attempt (UM0029776 had two). We reuse the case's existing force-sync job instead: if it's
  // in-flight, hand it back as-is; if it already finished, RE-QUEUE it in place (same row, same
  // sequence) so re-triggering just re-runs the single step rather than appending another.
  const existing = await db.job.findFirst({
    where: { caseRequestId: src.caseRequestId, systemKey: SPANNING_FORCE_SYNC_KEY },
    orderBy: { sequence: "desc" },
    select: { id: true, status: true },
  });
  if (existing && ["pending", "dispatched", "running"].includes(existing.status)) {
    return NextResponse.json({ ok: true, jobId: existing.id, reused: true });
  }

  // Ride the Spanning line's request (secretNames + config) so credential brokering + tenant/identity
  // config just work. No cascade: singleRun + its own dependsOn:[] so it can run on a finished case.
  const srcReq = (src.request ?? {}) as Record<string, unknown>;
  const config = (srcReq.config ?? {}) as Record<string, unknown>;
  // This job — and ONLY this job — signs in to the console, so it's where the portal secret is
  // attached. It is added ONLY when the client has actually wired it: an unwired name here would make
  // the job unclaimable (the claim gate treats every listed secret as required), so the operator would
  // watch it hang instead of getting the module's "wire a spanning-portal secret" warning. Unwired, the
  // job still runs, falls back to the API secret, and reports exactly what to fix.
  const srcSecretNames = Array.isArray(srcReq.secretNames) ? (srcReq.secretNames as unknown[]).filter((n): n is string => typeof n === "string") : [];
  const clientSecrets = await db.secret.findMany({ where: { clientId: src.case.clientId }, select: { name: true, externalId: true } });
  const secretNames = [...new Set([...srcSecretNames, ...wiredOptionalSecrets("spanning", clientSecrets)])];
  const request = { secretNames, config, dependsOn: [], requiresApproval: false, captureEvidence: false } as Prisma.InputJsonValue;

  let jobId: string;
  if (existing) {
    // Re-run the SAME finished force-sync job: reset it to a fresh claimable state (clearing the prior
    // attempt's result/validation/evidence/error) and refresh its request, so a re-trigger updates the
    // one step in place — mirrors requeueJob's field reset.
    await db.job.update({
      where: { id: existing.id },
      data: {
        status: "pending", assignedAgentId: null, request,
        result: Prisma.DbNull, validation: Prisma.DbNull, evidence: Prisma.DbNull, progress: Prisma.DbNull,
        error: null, startedAt: null, finishedAt: null,
      },
    });
    jobId = existing.id;
  } else {
    // First force-sync for this case — append a single new step at the end.
    const agg = await db.job.aggregate({ where: { caseRequestId: src.caseRequestId }, _max: { sequence: true } });
    const job = await db.job.create({
      data: {
        caseRequestId: src.caseRequestId, systemKey: SPANNING_FORCE_SYNC_KEY, mode: "api", sequence: (agg._max.sequence ?? 0) + 1,
        status: "pending", singleRun: true, request,
      },
      select: { id: true },
    });
    jobId = job.id;
  }
  await recordAudit("spanning.forcesync.dispatch", { user: _g.user, jobId, caseRequestId: src.caseRequestId, clientId: src.case.clientId, detail: { fromLine: src.systemKey, reused: Boolean(existing) } });
  return NextResponse.json({ ok: true, jobId });
}
