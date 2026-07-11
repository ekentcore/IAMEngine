// POST /api/fix-tasks/:id/dismiss — an operator reviewed the proposal (or a no_change/failed
// diagnosis) and is done with it: mark the task dismissed so the chip goes quiet. The fingerprint
// can then be re-triggered from /runs. Guarded to case.dispatch; audited.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const DISMISSIBLE = ["proposed", "no_change", "failed"];

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const g = await guard("case.dispatch");
  if (g.res) return g.res;

  const task = await db.fixTask.findUnique({ where: { id: params.id }, select: { id: true, status: true, title: true, fingerprint: true } });
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!DISMISSIBLE.includes(task.status)) {
    return NextResponse.json({ error: `a ${task.status} task can't be dismissed` }, { status: 409 });
  }

  await db.fixTask.update({ where: { id: task.id }, data: { status: "dismissed", finishedAt: new Date() } });
  await recordAudit("fixtask.dismiss", { user: g.user, detail: { id: task.id, fingerprint: task.fingerprint, title: task.title, priorStatus: task.status } });
  return NextResponse.json({ ok: true, status: "dismissed" });
}
