// POST /api/cases/:id/pause { paused: boolean } — operator pause/resume. A paused case's jobs are
// never claimed by runners (claim filters pausedAt: null), so systems can be adjusted / the case
// re-planned mid-run without a runner grabbing the next step.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { setCasePaused } from "@/lib/cases/actions";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.dispatch"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { paused?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const paused = Boolean(body.paused);
  // The write (pause/resume + scheduledFor clearing) and its audit row live in setCasePaused, shared
  // with the bulk route. Record WHO paused/resumed — the cases list shows "Paused: <name>" / "Unpaused".
  const r = await setCasePaused(db, params.id, _g.user, paused);
  if (!r.ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...r.result });
}
