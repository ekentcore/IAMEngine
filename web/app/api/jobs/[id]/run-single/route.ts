// POST /api/jobs/:id/run-single — run ONLY this step, in isolation (the case is paused so the
// rest of the run doesn't cascade). Body { force?: boolean }. Without force, unmet dependencies
// return 409 + { blockedBy } so the UI can warn-and-confirm; force re-runs it anyway.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { runSingleStep } from "@/lib/jobs/run-single";
import { auditActor } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  let force = false;
  try { force = Boolean((await req.json())?.force); } catch { /* empty body = not forced */ }

  const out = await runSingleStep(db, params.id, auditActor(_g.user, "ui"), force);
  if (!out.ok) {
    return NextResponse.json({ error: out.error, blockedBy: out.blockedBy }, { status: out.status });
  }
  return NextResponse.json({ ok: true, jobId: params.id, paused: out.paused });
}
