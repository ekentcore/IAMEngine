// POST /api/agents — enroll a runner. Returns the agent id to configure the runner with.
// (Production: gate this behind an enrollment token + issue a client cert for mTLS.)
import { NextResponse } from "next/server";
import type { AgentScope } from "@prisma/client";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

const SCOPES = ["central", "client_network"];

export async function POST(request: Request) {
  let body: { name?: unknown; scope?: unknown; clientSlug?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 422 });
  if (!SCOPES.includes(body.scope as string)) return NextResponse.json({ error: 'scope must be "central" or "client_network"' }, { status: 422 });
  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : null;

  try {
    const out = await makeRunnerService(db).enroll({ name, scope: body.scope as AgentScope, clientSlug });
    return NextResponse.json(out, { status: 201 });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
