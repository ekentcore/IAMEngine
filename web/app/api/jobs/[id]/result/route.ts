// POST /api/jobs/{id}/result — { status, result?, evidence?, validation?, error? }. Finalizes
// the job, advances the case, audits, and queues a ServiceNow work note.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError, type ResultInput } from "@/lib/jobs/types";

const STATUSES = ["succeeded", "failed", "skipped"];

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let body: { agentId?: unknown; status?: unknown; result?: unknown; evidence?: unknown; validation?: unknown; error?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  if (!STATUSES.includes(body.status as string)) {
    return NextResponse.json({ error: 'status must be "succeeded", "failed", or "skipped"' }, { status: 422 });
  }
  const input: ResultInput = {
    status: body.status as ResultInput["status"],
    result: body.result,
    evidence: body.evidence,
    validation: body.validation,
    error: typeof body.error === "string" ? body.error : null,
  };

  try {
    const out = await makeRunnerService(db).recordResult(params.id, body.agentId, input);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
