// POST /api/cases/:id/change/confirm — apply the operator's chosen removal mode (from the change
// preview modal) to a held mover case and release the "review" hold. Full reconciliation / removals
// are destructive, so this is gated on case.approve_destructive rather than case.dispatch.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { confirmChangeCase, NotChangeCaseError } from "@/lib/cases/change-service";
import { auditActor } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

const MODES = new Set(["scoped", "full", "add-only"]);

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const _g = await guard("case.approve_destructive"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { removalMode?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (typeof body.removalMode !== "string" || !MODES.has(body.removalMode)) {
    return NextResponse.json({ error: "removalMode must be scoped|full|add-only" }, { status: 422 });
  }
  try {
    const outcome = await confirmChangeCase(makeCaseRepository(db), params.id, body.removalMode as never, auditActor(_g.user, "ui:change-confirm"));
    return NextResponse.json(outcome);
  } catch (err) {
    if (err instanceof NotChangeCaseError) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
