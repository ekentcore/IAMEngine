// POST /api/runner/conn-tests/claim — { agentId, max? }. Atomically claims pending connection tests
// for this agent (central runner -> cloud tests; client agent -> its client's). Same scope rule as
// the job claim.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request) {
  let body: { agentId?: unknown; max?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  const n = Number(body.max);
  const max = Number.isFinite(n) ? Math.max(1, Math.min(25, Math.floor(n))) : 5;
  try {
    const tests = await makeRunnerService(db).claimConnectionTests(body.agentId, max);
    return NextResponse.json(tests);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
