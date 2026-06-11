// POST /api/jobs/:id/license { licenses: [{ name, skuId }] } — assign different M365 license(s) to a
// step that couldn't get its original (no seats), then re-run it. Writes the chosen SKUs into the
// step's config and re-queues (the idempotent executor assigns them; if a pick is also out of seats
// it warns + falls back to the procurement path again).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requeueJob } from "@/lib/jobs/requeue";
import { recordAudit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await guard("case.dispatch"); if (g.res) return g.res;

  let body: { licenses?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const licenses = Array.isArray(body.licenses)
    ? body.licenses
        .map((l) => l as { name?: unknown; skuId?: unknown })
        .filter((l) => typeof l.skuId === "string" && l.skuId)
        .map((l) => ({ name: String(l.name ?? l.skuId), skuId: String(l.skuId) }))
    : [];
  if (licenses.length === 0) return NextResponse.json({ error: "pick at least one license" }, { status: 422 });

  const job = await db.job.findUnique({ where: { id: params.id }, select: { id: true, systemKey: true, caseRequestId: true, request: true } });
  if (!job) return NextResponse.json({ error: "unknown job" }, { status: 404 });
  if (job.systemKey !== "m365") return NextResponse.json({ error: "license assignment applies to the m365 step" }, { status: 422 });

  // Write the chosen licenses into the step config, then re-queue (clears the prior outcome).
  const reqJson = { ...((job.request ?? {}) as Record<string, unknown>) };
  reqJson.config = { ...((reqJson.config ?? {}) as Record<string, unknown>), licenses };
  await db.job.update({ where: { id: job.id }, data: { request: reqJson as Prisma.InputJsonValue } });

  const out = await requeueJob(db, job.id, "ui:license");
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  await recordAudit("job.license.reassign", { user: g.user, jobId: job.id, caseRequestId: job.caseRequestId, detail: { licenses: licenses.map((l) => l.name) } });
  return NextResponse.json({ ok: true, licenses: licenses.map((l) => l.name) });
}
