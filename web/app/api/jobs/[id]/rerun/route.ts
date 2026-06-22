// POST /api/jobs/:id/rerun — re-dispatch a finished job (re-run / re-validate from the run
// report). The shared requeue helper resets the job to pending, clears its prior outcome, and
// nudges the case off a terminal status so the claim loop picks it up.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { requeueJob } from "@/lib/jobs/requeue";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const out = await requeueJob(db, params.id, "ui");
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ ok: true, jobId: params.id });
}
