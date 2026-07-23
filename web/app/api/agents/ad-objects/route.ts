// POST /api/agents/ad-objects — a client-network runner posts the AD objects it discovered on the
// DC: { agentId, ous: string[], groups: string[] }. Behind the runner-token middleware (/api/agents).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { agentId?: unknown; ous?: unknown; groups?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  try {
    const authed = await authenticateAgent(db, req, typeof body.agentId === "string" ? body.agentId : null);
    const res = await makeRunnerService(db).recordAdObjects(
      authed.id,
      Array.isArray(body.ous) ? (body.ous as string[]) : [],
      Array.isArray(body.groups) ? (body.groups as string[]) : []
    );
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
