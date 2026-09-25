// POST /api/cases/:id/steps { running: string[] } — set which of the client's systems run on THIS case
// (FR #173: switch on an on-request step the intake didn't signal; FR #134: switch off a step this case
// doesn't need), then re-plan so the case's jobs follow. Same gate as re-plan (case.plan): it changes
// what the case will do. The choice is stored as the difference from the natural plan and audited.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { auditActor } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { saveCaseSteps } from "@/lib/cases/case-steps-service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.plan"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { running?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (!Array.isArray(body.running) || !body.running.every((k) => typeof k === "string")) {
    return NextResponse.json({ error: "running must be a list of system keys" }, { status: 422 });
  }
  const r = await saveCaseSteps(db, params.id, body.running as string[], auditActor(_g.user, "ui"));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  if (!r.replan.ok) return NextResponse.json({ error: `saved, but the re-plan failed: ${r.replan.error}`, requestedSystems: r.requestedSystems, skippedSystems: r.skippedSystems }, { status: 409 });
  return NextResponse.json({ ok: true, requestedSystems: r.requestedSystems, skippedSystems: r.skippedSystems, outcome: r.replan.outcome });
}
