// POST /api/runner/conn-tests/{id}/result — { agentId, ok, detail }. The runner reports whether the
// connect + read probe succeeded, with a one-line detail (what it saw, or the error).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let body: { agentId?: unknown; ok?: unknown; detail?: unknown; accessOk?: unknown; accessDetail?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (typeof body.agentId !== "string" || !body.agentId) return NextResponse.json({ error: "agentId is required" }, { status: 422 });
  if (typeof body.ok !== "boolean") return NextResponse.json({ error: "ok (boolean) is required" }, { status: 422 });
  const detail = typeof body.detail === "string" ? body.detail : "";
  // Two-stage result — older runners omit these; null = unknown.
  const accessOk = typeof body.accessOk === "boolean" ? body.accessOk : null;
  const accessDetail = typeof body.accessDetail === "string" ? body.accessDetail : null;
  try {
    const out = await makeRunnerService(db).reportConnectionTest(params.id, body.agentId, body.ok, detail, accessOk, accessDetail);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
