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

  // Conditional claim (like apply's): the status must still be dismissible at write time. A plain
  // update() after the findUnique check would let a concurrent Apply (proposed→applying) be
  // overwritten by this dismiss, silencing the chip while the apply worker still opens a PR.
  const claimed = await db.fixTask.updateMany({
    where: { id: task.id, status: { in: DISMISSIBLE } },
    data: { status: "dismissed", finishedAt: new Date() },
  });
  if (claimed.count === 0) return NextResponse.json({ error: "this task can no longer be dismissed (it may have just been applied)" }, { status: 409 });
  await recordAudit("fixtask.dismiss", { user: g.user, detail: { id: task.id, fingerprint: task.fingerprint, title: task.title, priorStatus: task.status } });
  return NextResponse.json({ ok: true, status: "dismissed" });
}
