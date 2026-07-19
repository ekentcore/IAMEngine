// POST /api/cases/change — create + plan a "change" (mover / ad-hoc access) case. Mirrors
// /api/cases/route.ts's POST handler but delegates to the change-service planner instead of
// planning-service's onboard/offboard path.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { createChangeCase } from "@/lib/cases/change-service";
import { auditActor } from "@/lib/auth/audit";
import type { ChangePayload } from "@/lib/cases/change-types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const _g = await guard("case.import"); if (_g.res) return _g.res;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const payload = (body.payload && typeof body.payload === "object" ? body.payload : null) as ChangePayload | null;
  if (!clientSlug || !payload || typeof payload.userToChange !== "string" || (payload.changeKind !== "mover" && payload.changeKind !== "adhoc")) {
    return NextResponse.json({ error: "clientSlug and payload{ userToChange, changeKind: mover|adhoc } are required" }, { status: 422 });
  }

  // scope-gated: can't create a case for a client you can't see (reads as a missing client).
  const scope = await currentClientScope(db);
  if (scope !== null) {
    const target = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
    if (!target || !scopeAllows(scope, target.id)) return NextResponse.json({ error: `client not found: ${clientSlug}` }, { status: 404 });
  }

  try {
    const outcome = await createChangeCase(
      makeCaseRepository(db),
      { clientSlug, payload, subject: typeof body.subject === "string" ? body.subject : null, dryRun: body.dryRun === true, source: "manual" },
      auditActor(_g.user, "ui:change-case")
    );
    return NextResponse.json(outcome, { status: 201 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const status = reason.startsWith("client not found") ? 404 : 500;
    return NextResponse.json({ error: reason }, { status });
  }
}
