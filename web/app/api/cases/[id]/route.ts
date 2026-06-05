// GET   /api/cases/:id — case detail with planned jobs.
// PATCH /api/cases/:id — { action: "set-dry-run", dryRun } toggle the case's dry-run mode.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const c = await makeCaseRepository(db).getCase(params.id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(c);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let body: { action?: string; dryRun?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  if (body.action === "set-dry-run") {
    if (typeof body.dryRun !== "boolean") return NextResponse.json({ error: "dryRun must be a boolean" }, { status: 422 });
    const exists = await db.caseRequest.findUnique({ where: { id: params.id }, select: { id: true, clientId: true } });
    if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });
    const updated = await makeCaseRepository(db).setCaseDryRun(params.id, body.dryRun);
    await db.auditLog.create({ data: { actor: "ui", action: "case.dry_run.set", clientId: exists.clientId, detail: { caseId: params.id, dryRun: body.dryRun, jobsUpdated: updated } } });
    return NextResponse.json({ dryRun: body.dryRun, jobsUpdated: updated });
  }
  return NextResponse.json({ error: 'action must be "set-dry-run"' }, { status: 422 });
}
