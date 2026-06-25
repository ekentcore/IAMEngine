// POST /api/jobs/:id/retry-now — run a step that's WAITING on a vendor sync (Spanning/Mimecast
// "user not discovered yet", request.autoRetry) immediately, instead of at its scheduled time. This
// is exactly the re-queue the scheduled sweep (sweepAutoRetries) would do when the timer fires — so
// if the vendor still hasn't synced, recordResult reschedules the next attempt as if this had been
// the scheduled run.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { requeueJob } from "@/lib/jobs/requeue";
import { actorLabel } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const out = await requeueJob(db, params.id, actorLabel(_g.user, "ui:retry-now"));
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  await db.auditLog.create({ data: { actor: actorLabel(_g.user, "ui"), action: "job.autoretry.retry_now", jobId: params.id } });
  return NextResponse.json({ ok: true, jobId: params.id });
}
