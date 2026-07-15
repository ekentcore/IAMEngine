// GET /api/clients/:slug/rules — load personas/globals (+ the client's system keys) for the editor.
// PUT /api/clients/:slug/rules — { personas, globals } — validate every condition, then persist.
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { auditActor } from "@/lib/auth/audit";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { validateRules } from "@/lib/clients/rules";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rules = await makeClientRepository(db).getRules(params.slug);
  if (!rules) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(rules);
}

export async function PUT(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
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

  // Only overwrite a scope that's actually present in the payload — an absent field keeps the
  // existing rules (a partial PUT must not silently wipe the other column). Sending `{}` clears.
  const personas = checked.value.personas ?? existing.personas ?? {};
  const globals = checked.value.globals ?? existing.globals ?? {};
  const globalsOffboard = checked.value.globalsOffboard ?? existing.globalsOffboard ?? {};
  const client = await repo.setRules(params.slug, personas, globals, globalsOffboard);
  // Record the unconditionally-added global groups in the audit detail so a config-seeded
  // privilege grant (e.g. an "always add Domain Admins" rule) is visible after the fact — the actor
  // says who, the detail must say what.
  const alwaysGlobalGroups = Object.values((globals ?? {}) as Record<string, { groups?: unknown[] }>)
    .flatMap((f) => (Array.isArray(f?.groups) ? f.groups : []))
    .filter((g): g is string => typeof g === "string");
  // Summarize the OFFBOARD rules too, so a tampered offboard edit (a deliberately-thin removeGroups
  // that leaves admin access, or a moveToOu to a privileged OU) is visible in the audit.
  const offboardSummary = Object.entries((globalsOffboard ?? {}) as Record<string, { groups?: unknown[]; ou?: unknown }>).map(([sys, f]) => ({
    sys,
    removeGroups: Array.isArray(f?.groups) ? f.groups.filter((g): g is string => typeof g === "string") : [],
    moveToOu: typeof f?.ou === "string" ? f.ou : undefined,
  }));
  const who = auditActor(_g.user, "ui");
  await repo.writeAudit({
    actor: who.label,
    userId: who.userId,
    action: "client.rules.edit",
    clientId: client.id,
    detail: {
      personaCount: Object.keys(personas as object).length,
      globalSystems: Object.keys(globals as object),
      alwaysGlobalGroups,
      offboard: offboardSummary,
    },
  });
  return NextResponse.json({ ok: true });
}
