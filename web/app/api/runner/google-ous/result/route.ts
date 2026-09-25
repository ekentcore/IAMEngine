// POST /api/runner/google-ous/result — { agentId, clientSlug, ous: string[], error? }. The central runner
// posts the tenant's Google OU paths (FR #81); stored on the client to back the Google OU pickers. An
// `error` keeps the last good list and records why this read failed.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request) {
  let body: { agentId?: unknown; clientSlug?: unknown; ous?: unknown; error?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  if (typeof body.clientSlug !== "string" || !body.clientSlug) return NextResponse.json({ error: "clientSlug is required" }, { status: 422 });
  const ous = Array.isArray(body.ous) ? body.ous.filter((o): o is string => typeof o === "string") : [];
  const error = typeof body.error === "string" && body.error ? body.error : null;
  try {
    const authed = await authenticateAgent(db, request, body.agentId);
    return NextResponse.json(await makeRunnerService(db).reportGoogleOus(authed.id, body.clientSlug, ous, error));
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
