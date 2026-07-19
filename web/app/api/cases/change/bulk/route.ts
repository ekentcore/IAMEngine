// POST /api/cases/change/bulk { clientSlug, template{ changeKind, ... }, users[] } — fan one change
// transition across N existing users, one change case each (keeps the one-user-per-case model).
// Mirrors /api/cases/bulk/route.ts's shape (ONE guard, validate + dedupe + cap, then per-item work
// that never lets one failure abort the batch). Bounded at MAX = 100.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { createChangeCase } from "@/lib/cases/change-service";
import { auditActor } from "@/lib/auth/audit";
import type { ChangePayload } from "@/lib/cases/change-types";

export const dynamic = "force-dynamic";
const MAX = 100;

export async function POST(req: Request) {
  const _g = await guard("case.import"); if (_g.res) return _g.res;
  let body: { clientSlug?: unknown; users?: unknown; template?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const template = (body.template && typeof body.template === "object" ? body.template : null) as Partial<ChangePayload> | null;
  if (!clientSlug || !template || (template.changeKind !== "mover" && template.changeKind !== "adhoc")) {
    return NextResponse.json({ error: "clientSlug and template{ changeKind } are required" }, { status: 422 });
  }
  if (!Array.isArray(body.users) || body.users.some((u) => typeof u !== "string")) {
    return NextResponse.json({ error: "users[] (display names or UPNs) is required" }, { status: 422 });
  }
  const users = [...new Set((body.users as string[]).map((s) => s.trim()).filter(Boolean))].slice(0, MAX);
  if (users.length === 0) return NextResponse.json({ error: "no users given" }, { status: 422 });

  const scope = await currentClientScope(db);
  if (scope !== null) {
    const target = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
    if (!target || !scopeAllows(scope, target.id)) return NextResponse.json({ error: `client not found: ${clientSlug}` }, { status: 404 });
  }

  const repo = makeCaseRepository(db);
  const results: { user: string; ok: boolean; caseId?: string; error?: string }[] = [];
  for (const user of users) {
    try {
      const outcome = await createChangeCase(repo, { clientSlug, payload: { ...(template as ChangePayload), userToChange: user }, source: "manual" }, auditActor(_g.user, "ui:change-bulk"));
      results.push({ user, ok: true, caseId: outcome.caseId });
    } catch (e) {
      results.push({ user, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  await recordAudit("case.change.bulk", { user: _g.user, detail: { clientSlug, requested: users.length, ok } });
  return NextResponse.json({ results, ok, failed: results.length - ok });
}
