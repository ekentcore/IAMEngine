// POST   /api/jobs/:id/procurement { number } — watch a Procurement Case for this job; when the PC
//                                               resolves in ServiceNow, the job auto-re-queues.
// DELETE /api/jobs/:id/procurement             — stop watching.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function POST(req: Request, { params }: Ctx) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { number?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const number = typeof body.number === "string" ? body.number.trim().toUpperCase() : "";
  // Task numbers are PREFIX+digits (PC0012345). Keep the prefix loose — orgs rename task types —
  // but require the shape so a pasted sentence or URL is rejected early.
  if (!/^[A-Z]{1,6}\d{4,12}$/.test(number)) {
    return NextResponse.json({ error: "enter the case number, e.g. PC0012345" }, { status: 422 });
  }
  const job = await db.job.findUnique({ where: { id: params.id }, select: { id: true, caseRequestId: true } });
  if (!job) return NextResponse.json({ error: "unknown job" }, { status: 404 });

  // Re-saving replaces the watch (e.g. a typo'd number) and restarts it.
  const watch = await db.procurementWatch.upsert({
    where: { jobId: job.id },
    create: { jobId: job.id, number },
    update: { number, state: "watching", note: null, lastCheckedAt: null },
  });
  await recordAudit("procurement.watch.set", { user: _g.user, jobId: job.id, caseRequestId: job.caseRequestId, detail: { number } });
  return NextResponse.json({ ok: true, watch: { number: watch.number, state: watch.state } });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const deleted = await db.procurementWatch.deleteMany({ where: { jobId: params.id } });
  if (deleted.count > 0) {
    await recordAudit("procurement.watch.clear", { user: _g.user, jobId: params.id });
  }
  return NextResponse.json({ ok: true });
}
