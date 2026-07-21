// GET  /api/clients/:slug/intake-rules — load the client's intake rules + its system keys (editor).
// PUT  /api/clients/:slug/intake-rules — { rules: [...] } — validate, persist, audit (FR #0000019).
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { auditActor } from "@/lib/auth/audit";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { validateIntakeRulesBody } from "@/lib/clients/intake-rules-validate";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const data = await makeClientRepository(db).getIntakeRules(params.slug);
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PUT(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const checked = validateIntakeRulesBody(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 422 });

  const repo = makeClientRepository(db);
  const existing = await repo.getIntakeRules(params.slug);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await repo.setIntakeRules(params.slug, checked.value);

  const who = auditActor(_g.user, "ui");
  await repo.writeAudit({
    actor: who.label,
    userId: who.userId,
    action: "client.intake_rules.edit",
    clientId: client.id,
    detail: {
      ruleCount: checked.value.rules.length,
      rules: checked.value.rules.map((r) => ({
        id: r.id, label: r.label,
        contacts: r.match.contacts.map((c) => c.name),
        skipSystems: r.effects.skipSystems,
        forceDomain: r.effects.forceDomain,
      })),
    },
  });
  return NextResponse.json({ ok: true });
}
