// POST /api/runner/cloud-groups/claim — { agentId }. The central (cloud) runner claims pending cloud
// group discoveries; the response carries the brokered m365 credential fields (push-down). Never
// cache — it carries secret values.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  let body: { agentId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  try {
    const authed = await authenticateAgent(db, request, typeof body.agentId === "string" ? body.agentId : null);
    const work = await makeRunnerService(db).claimCloudGroupDiscovery(authed.id);
    return NextResponse.json(work, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
