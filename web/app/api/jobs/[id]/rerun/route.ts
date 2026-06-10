// POST /api/jobs/:id/rerun — re-dispatch a finished job (re-run / re-validate from the run
// report). The shared requeue helper resets the job to pending, clears its prior outcome, and
// nudges the case off a terminal status so the claim loop picks it up.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requeueJob } from "@/lib/jobs/requeue";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const out = await requeueJob(db, params.id, "ui");
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ ok: true, jobId: params.id });
}
