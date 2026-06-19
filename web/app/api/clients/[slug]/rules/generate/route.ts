// POST /api/clients/:slug/rules/generate — draft a persona/rule from plain English (LLM). Drafts
// only; never persists (the editor reviews then PUTs to /rules). Grounded in the client's discovered
// cloud groups + AD OUs/groups so the model uses real names.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { generateRuleDraft, type RuleDraft } from "@/lib/rules/nl-rule";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  let body: { text?: unknown; kind?: unknown; action?: unknown; systemKey?: unknown; current?: unknown; correction?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const rules = await makeClientRepository(db).getRules(params.slug);
  if (!rules) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Discovered objects for grounding (same JSON the editor loads): adObjects {ous, groups},
  // cloudGroups { groups: [{ name, type }] }.
  const ad = (rules.adObjects ?? {}) as { ous?: string[]; groups?: string[] };
  const cloud = ((rules.cloudGroups ?? {}) as { groups?: { name: string }[] }).groups ?? [];
  const knownGroups = [...new Set([...(ad.groups ?? []), ...cloud.map((g) => g.name)].filter(Boolean))];
  const knownOus = ad.ous ?? [];

  const draft = await generateRuleDraft({
    text: String(body.text ?? ""),
    kind: body.kind === "persona" ? "persona" : "rule",
    action: body.action === "offboard" ? "offboard" : "onboard",
    systemKey: typeof body.systemKey === "string" ? body.systemKey : undefined,
    knownGroups,
    knownOus,
    current: (body.current as RuleDraft) ?? undefined,
    correction: typeof body.correction === "string" ? body.correction : undefined,
  });

  // draft === null ⇒ AI not configured/available (or empty input); the editor falls back to manual.
  return NextResponse.json({ ok: true, draft, usedAI: draft != null });
}
