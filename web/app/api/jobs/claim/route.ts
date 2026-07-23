// POST /api/jobs/claim — { agentId, batchSize?, version? }. Atomically claims eligible api jobs.
// version = the claiming runner's build id; the service refuses to dispatch to an outdated runner.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request) {
  let body: { agentId?: unknown; batchSize?: unknown; version?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  const n = Number(body.batchSize);
  const batchSize = Number.isFinite(n) ? Math.max(1, Math.min(25, Math.floor(n))) : 5;
  const version = typeof body.version === "string" ? body.version : null;

  try {
    const authed = await authenticateAgent(db, request, typeof body.agentId === "string" ? body.agentId : null);
    const jobs = await makeRunnerService(db).claim(authed.id, batchSize, version);
    return NextResponse.json(jobs);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
