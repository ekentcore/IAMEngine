// POST /api/agents/heartbeat — { agentId, version?, semver? }. Updates lastSeenAt + version (the
// content-hash build id) + semver (the human release version).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request) {
  let body: { agentId?: unknown; version?: unknown; semver?: unknown; startedAt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  const version = typeof body.version === "string" ? body.version : null;
  const semver = typeof body.semver === "string" ? body.semver : null;
  const startedAt = typeof body.startedAt === "string" ? body.startedAt : null;

  try {
    const out = await makeRunnerService(db).heartbeat(body.agentId, version, semver, startedAt);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
