// POST /api/fix-tasks/:id/apply — an operator reviewed the on-screen proposal and wants it
// shipped: flip the task to "applying" and spawn the detached apply worker (isolated worktree →
// drift check → tsc/tests → DRAFT PR; a human always merges). Guarded to case.dispatch. The
// status flip is a conditional update so two concurrent clicks can't spawn two workers.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { spawnFixer } from "@/lib/fixes/fix-tasks";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const g = await guard("case.dispatch");
  if (g.res) return g.res;

  const task = await db.fixTask.findUnique({ where: { id: params.id }, select: { id: true, status: true, title: true, fingerprint: true, proposal: true } });
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (task.status !== "proposed" || !task.proposal) {
    return NextResponse.json({ error: `only a proposed fix can be applied (this task is ${task.status})` }, { status: 409 });
  }

  const claimed = await db.fixTask.updateMany({
    where: { id: task.id, status: "proposed" },
    data: { status: "applying", appliedBy: g.user?.email ?? "operator", appliedAt: new Date(), finishedAt: null },
  });
  if (claimed.count === 0) return NextResponse.json({ error: "someone else just applied this fix" }, { status: 409 });

  try {
    spawnFixer(task.id, "apply");
  } catch (e) {
    await db.fixTask.update({ where: { id: task.id }, data: { status: "failed", finishedAt: new Date(), log: `failed to launch the apply worker: ${(e as Error).message}` } }).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  await recordAudit("fixtask.apply", { user: g.user, detail: { id: task.id, fingerprint: task.fingerprint, title: task.title } });
  return NextResponse.json({ ok: true, status: "applying" });
}
