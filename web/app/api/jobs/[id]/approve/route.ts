// POST /api/jobs/{id}/approve — { approvedBy }. Releases an approval-gated job so it can be
// claimed. Server-side gate per CLAUDE.md (destructive steps need a recorded approval).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { jobInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { auditActor } from "@/lib/auth/audit";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.approve_destructive"); if (_g.res) return _g.res;
  if (!(await jobInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Body is optional — approvedBy defaults to the authenticated operator (so the UI can approve with
  // a single click and still record WHO approved). The signed-in account WINS over a body-supplied
  // name: this releases a destructive step, so the approval has to name the account that authorized
  // it (a caller-supplied label only stands in when there's no session, i.e. auth off).
  let body: { approvedBy?: unknown } = {};
  try { body = await request.json(); } catch { /* no/empty body is fine — fall back to the operator */ }
  const claimed = (typeof body.approvedBy === "string" && body.approvedBy.trim()) || _g.user.email;
  const approvedBy = auditActor(_g.user, claimed);
  if (!approvedBy.label) return NextResponse.json({ error: "approvedBy is required" }, { status: 422 });

  try {
    const out = await makeRunnerService(db).approveJob(params.id, approvedBy);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
