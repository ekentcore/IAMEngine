// POST /api/jobs/{id}/approve — { approvedBy }. Releases an approval-gated job so it can be
// claimed. Server-side gate per CLAUDE.md (destructive steps need a recorded approval).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.approve_destructive"); if (_g.res) return _g.res;
  let body: { approvedBy?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const approvedBy = typeof body.approvedBy === "string" ? body.approvedBy.trim() : "";
  if (!approvedBy) return NextResponse.json({ error: "approvedBy is required" }, { status: 422 });

  try {
    const out = await makeRunnerService(db).approveJob(params.id, approvedBy);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
