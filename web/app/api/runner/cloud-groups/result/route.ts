// POST /api/runner/cloud-groups/result — { agentId, clientSlug, groups:[{name,type}] }. The runner
// posts the discovered tenant groups; stored on the client to back the group pickers.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request) {
  let body: { agentId?: unknown; clientSlug?: unknown; groups?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  if (typeof body.clientSlug !== "string" || !body.clientSlug) return NextResponse.json({ error: "clientSlug is required" }, { status: 422 });
  const groups = Array.isArray(body.groups)
    ? body.groups.filter((g): g is { name: string; type: string } => !!g && typeof g === "object" && typeof (g as { name?: unknown }).name === "string")
        .map((g) => ({ name: String((g as { name: unknown }).name), type: String((g as { type?: unknown }).type ?? "security") }))
    : [];
  try {
    const authed = await authenticateAgent(db, request, typeof body.agentId === "string" ? body.agentId : null);
    const out = await makeRunnerService(db).reportCloudGroups(authed.id, body.clientSlug, groups);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
