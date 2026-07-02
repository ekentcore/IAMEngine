// POST /api/agents — enroll a runner. Returns the agent id to configure the runner with.
// (Production: gate this behind an enrollment token + issue a client cert for mTLS.)
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import type { AgentScope } from "@prisma/client";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";
import { verifyEnrollToken, enrollSecret } from "@/lib/runner/enroll-token";

const SCOPES = ["central", "client_network"];

// Constant-time string compare (no early-exit timing oracle on the shared enrollment token).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(request: Request) {
  let body: { name?: unknown; scope?: unknown; clientSlug?: unknown; enrollToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 422 });

  // The one-line installer carries a short-lived HMAC enroll token that itself authorizes a
  // specific scope+client. Otherwise (manual enroll) require the shared ENROLLMENT_TOKEN header
  // (when configured) and take scope/client from the body.
  let scope: string;
  let clientSlug: string | null;
  if (typeof body.enrollToken === "string" && body.enrollToken) {
    const claims = verifyEnrollToken(body.enrollToken, enrollSecret(), Date.now());
    if (!claims) return NextResponse.json({ error: "enrollment token invalid or expired" }, { status: 401 });
    scope = claims.scope;
    clientSlug = claims.client;
  } else {
    const shared = process.env.ENROLLMENT_TOKEN;
    if (shared) {
      if (!safeEqual(request.headers.get("x-enrollment-token") ?? "", shared)) {
        return NextResponse.json({ error: "invalid enrollment token" }, { status: 401 });
      }
    } else if (process.env.NODE_ENV === "production" || process.env.RUNNER_AUTH_REQUIRED === "true") {
      // Production-gated fail-CLOSED: no signed enrollToken and no shared ENROLLMENT_TOKEN configured —
      // refuse open enrollment in prod (an unauthenticated agent could then claim jobs + broker creds).
      return NextResponse.json({ error: "enrollment requires a token" }, { status: 503 });
    }
    scope = body.scope as string;
    clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : null;
  }
  if (!SCOPES.includes(scope)) return NextResponse.json({ error: 'scope must be "central" or "client_network"' }, { status: 422 });

  try {
    const out = await makeRunnerService(db).enroll({ name, scope: scope as AgentScope, clientSlug });
    return NextResponse.json(out, { status: 201 });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
