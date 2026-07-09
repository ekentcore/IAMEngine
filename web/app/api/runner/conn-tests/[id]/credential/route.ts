// POST /api/runner/conn-tests/{id}/credential — { agentId, secretName }. Push-down broker for a
// connection test (same model as a job credential): the app resolves the Delinea value and returns
// the fields. Never cache — the body carries the secret value.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let body: { agentId?: unknown; secretName?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  if (typeof body.secretName !== "string" || !body.secretName) return NextResponse.json({ error: "secretName is required" }, { status: 422 });
  try {
    const cred = await makeRunnerService(db).brokerConnectionTestCredential(params.id, body.agentId, body.secretName);
    return NextResponse.json(cred, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
