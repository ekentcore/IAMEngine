// GET /api/clients/:slug/rules — load personas/globals (+ the client's system keys) for the editor.
// PUT /api/clients/:slug/rules — { personas, globals } — validate every condition, then persist.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { validateRules } from "@/lib/clients/rules";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const rules = await makeClientRepository(db).getRules(params.slug);
  if (!rules) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(rules);
}

export async function PUT(req: Request, { params }: { params: { slug: string } }) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const checked = validateRules(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 422 });

  const repo = makeClientRepository(db);
  const existing = await repo.getRules(params.slug);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const client = await repo.setRules(params.slug, checked.value.personas ?? {}, checked.value.globals ?? {});
  await repo.writeAudit({
    actor: "ui",
    action: "client.rules.edit",
    clientId: client.id,
    detail: { personaCount: Object.keys(checked.value.personas ?? {}).length, globalSystems: Object.keys(checked.value.globals ?? {}) },
  });
  return NextResponse.json({ ok: true });
}
