// POST /api/cases/:id/hard-match — operator-confirmed hard-match: dispatch a single on-prem job that
// sets the on-prem mS-DS-ConsistencyGuid to the existing Entra object's immutableId, so AAD Connect
// LINKS them instead of duplicating. Only offered after the consistency check flags a mismatch; the
// immutableId comes from the m365/entra result. Anchor-mismatch case only (a cloud-only object has no
// immutableId to copy — 422, resolve manually).
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.approve_destructive"); if (_g.res) return _g.res; // a deliberate, sensitive AD write
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, jobs: { select: { systemKey: true, sequence: true, status: true, result: true } } },
  });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cloud = c.jobs.find((j) => (j.systemKey === "m365" || j.systemKey === "entra") && j.status === "succeeded");
  const res = (cloud?.result ?? {}) as Record<string, unknown>;
  const immutableId = res.OnPremImmutableId ?? res.onPremImmutableId;
  if (typeof immutableId !== "string" || !immutableId) {
    return NextResponse.json({ error: "no Entra immutableId available to link to — the cloud object may be cloud-only; resolve the link manually" }, { status: 422 });
  }

  // Dispatch a single on-prem hard-match job (claimed by the client agent; central can't reach AD).
  const seq = Math.max(0, ...c.jobs.map((j) => j.sequence)) + 1;
  const job = await db.job.create({
    data: {
      caseRequestId: c.id, systemKey: "ad-hard-match", mode: "api", sequence: seq, status: "pending",
      request: { secretNames: ["ad-dc"], config: { immutableId }, dependsOn: [], requiresApproval: false, captureEvidence: false } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  // Make it claimable even on a completed case; recordResult recomputes the status when it finishes.
  if (c.status === "completed" || c.status === "failed") {
    await db.caseRequest.update({ where: { id: c.id }, data: { status: "running" } });
  }
  await db.auditLog.create({ data: { actor: _g.user.email || "ui", action: "case.hard_match.dispatch", caseRequestId: c.id, detail: { jobId: job.id } } });
  return NextResponse.json({ ok: true, jobId: job.id });
}
