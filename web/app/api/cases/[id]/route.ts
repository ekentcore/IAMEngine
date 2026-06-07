// GET    /api/cases/:id — case detail with planned jobs.
// PATCH  /api/cases/:id — { action: "set-dry-run", dryRun } | { action: "restore" }.
// DELETE /api/cases/:id — move the case to the trash (restorable 30 days). Blocked while in flight.
//        DELETE /api/cases/:id?forever=1 — permanently delete a trashed case + its jobs.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { hasStartedJobs } from "@/lib/cases/job-status";

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
    const exists = await db.caseRequest.findUnique({ where: { id: params.id }, select: { id: true, clientId: true, dryRun: true, jobs: { select: { status: true } } } });
    if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });
    // Mode can't change once execution has begun (the UI also disables it; enforce it here too).
    if (hasStartedJobs(exists.jobs)) return NextResponse.json({ error: "a job has already started — re-plan to change the mode" }, { status: 409 });
    const updated = await makeCaseRepository(db).setCaseDryRun(params.id, body.dryRun);
    await db.auditLog.create({ data: { actor: "ui", action: "case.dry_run.set", clientId: exists.clientId, detail: { caseId: params.id, from: exists.dryRun, to: body.dryRun, jobsUpdated: updated } } });
    return NextResponse.json({ dryRun: body.dryRun, jobsUpdated: updated });
  }
  if (body.action === "restore") {
    const res = await makeCaseRepository(db).restoreCase(params.id);
    if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    await db.auditLog.create({ data: { actor: "ui", action: "case.restore", clientId: res.clientId, detail: { caseId: params.id } } });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'action must be "set-dry-run" or "restore"' }, { status: 422 });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const repo = makeCaseRepository(db);
  const forever = new URL(req.url).searchParams.get("forever") === "1";

  if (forever) {
    const res = await repo.deleteCaseForever(params.id);
    if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    await db.auditLog.create({ data: { actor: "ui", action: "case.delete_forever", clientId: res.clientId, detail: { caseId: params.id, subject: res.subject } } });
    return NextResponse.json({ ok: true });
  }

  const res = await repo.trashCase(params.id);
  if (!res.ok) {
    if (res.reason === "not_found") return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ error: "a job is in flight — wait for it to finish (or re-plan) before removing" }, { status: 409 });
  }
  await db.auditLog.create({ data: { actor: "ui", action: "case.trash", clientId: res.clientId, detail: { caseId: params.id, subject: res.subject } } });
  return NextResponse.json({ ok: true });
}
