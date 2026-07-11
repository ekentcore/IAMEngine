// POST /api/runner/conn-tests/{id}/result — { agentId, ok, detail }. The runner reports whether the
// connect + read probe succeeded, with a one-line detail (what it saw, or the error). Newer runners
// may add rights[] (per-operation permission results) and credExpiresAt (the credential's own expiry).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { parseRights } from "@/lib/jobs/conn-test-logic";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  let body: { agentId?: unknown; ok?: unknown; detail?: unknown; accessOk?: unknown; accessDetail?: unknown; rights?: unknown; credExpiresAt?: unknown };
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
  // Optional extras — malformed entries are dropped, absent means null (older runner).
  const rights = parseRights(body.rights);
  const credExpiresAt = typeof body.credExpiresAt === "string" && !Number.isNaN(Date.parse(body.credExpiresAt)) ? new Date(body.credExpiresAt) : null;
  try {
    const out = await makeRunnerService(db).reportConnectionTest(params.id, body.agentId, body.ok, detail, accessOk, accessDetail, rights, credExpiresAt);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
