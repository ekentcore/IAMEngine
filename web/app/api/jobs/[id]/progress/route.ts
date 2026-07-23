// POST /api/jobs/{id}/progress — { agentId, phase?, stage? }. Lightweight live-progress beacon the
// runner posts as it enters each phase of a job (connecting, enabling mailbox, validating…).
// Append-only; ignored once the job is terminal. `phase` is free-text narration shown in the run
// report; `stage` is a coarse setup-stage marker (signin|create|harvest|vault) for a browser
// credential-setup run, stored on a scalar column the guided-setup run checklist reads. At least one
// of the two must be present.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let body: { agentId?: unknown; phase?: unknown; stage?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  const phase = typeof body.phase === "string" && body.phase ? body.phase : undefined;
  const stage = typeof body.stage === "string" && body.stage ? body.stage : undefined;
  if (!phase && !stage) return NextResponse.json({ error: "phase or stage is required" }, { status: 422 });

  try {
    const authed = await authenticateAgent(db, request, typeof body.agentId === "string" ? body.agentId : null);
    const out = await makeRunnerService(db).recordProgress(params.id, authed.id, phase, stage);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
