// POST /api/jobs/{id}/progress — { agentId, phase }. Lightweight live-progress beacon the runner
// posts as it enters each phase of a job (connecting, enabling mailbox, validating…). Append-only;
// ignored once the job is terminal. Surfaced in the run report so an operator can see what a step
// is doing in real time.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let body: { agentId?: unknown; phase?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  if (typeof body.phase !== "string" || !body.phase) return NextResponse.json({ error: "phase is required" }, { status: 422 });

  try {
    const out = await makeRunnerService(db).recordProgress(params.id, body.agentId, body.phase);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
