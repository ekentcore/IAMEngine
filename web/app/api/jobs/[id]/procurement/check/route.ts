// POST /api/jobs/:id/procurement/check — check the watched Procurement Case against ServiceNow
// RIGHT NOW (the "Check now" button), instead of waiting for the ~5-minute sweep interval.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { checkProcurementWatch } from "@/lib/jobs/procurement-watch";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const watch = await db.procurementWatch.findUnique({
    where: { jobId: params.id },
    select: { id: true, jobId: true, number: true, state: true },
  });
  if (!watch) return NextResponse.json({ error: "no procurement watch on this job" }, { status: 404 });
  if (watch.state !== "watching") return NextResponse.json({ error: `watch is ${watch.state} — re-save the PC number to restart it` }, { status: 409 });

  await db.procurementWatch.update({ where: { id: watch.id }, data: { lastCheckedAt: new Date() } });
  await checkProcurementWatch(db, watch);
  const after = await db.procurementWatch.findUnique({ where: { id: watch.id }, select: { state: true, note: true } });
  return NextResponse.json({ ok: true, state: after?.state, note: after?.note });
}
