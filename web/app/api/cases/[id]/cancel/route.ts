// POST /api/cases/:id/cancel — stop a running case: abort every in-flight (dispatched/running) step
// and pause the case so no further steps are claimed. Non-destructive (the case stays, restorable to
// running by resuming/re-planning) — distinct from trashing it. Mirrors the per-step Stop, applied to
// the whole case.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { cancelCase } from "@/lib/cases/actions";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Stopping the in-flight steps + pausing + clearing any schedule lives in cancelCase (shared with
  // the bulk route).
  const r = await cancelCase(db, params.id, _g.user);
  if (!r.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...r.result });
}
