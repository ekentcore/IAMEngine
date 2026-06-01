// POST /api/jobs/{id}/credential — { agentId, secretName }. Least-privilege Delinea broker.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

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
    const cred = await makeRunnerService(db).brokerCredential(params.id, body.agentId, body.secretName);
    return NextResponse.json(cred);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
