// POST /api/clients/:slug/runbook — { action, text } parse a pasted runbook into RunbookSection
// rows for clients with no ServiceNow KB. GET (?action=) previews the parse without saving.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import type { Action } from "@prisma/client";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { saveRunbook } from "@/lib/clients/runbook-repo";
import { parseRunbookText, type ParsedSection } from "@/lib/clients/runbook-parse";
import { sectionsFromSystems } from "@/lib/clients/runbook-from-systems";
import { extractRunbookAI } from "@/lib/clients/runbook-extract";
import { CATALOG } from "@/lib/generator/system-map";

export const dynamic = "force-dynamic";

const isAction = (a: unknown): a is Action => a === "onboard" || a === "offboard";
const KNOWN = new Set(Object.keys(CATALOG));

// Validate + normalize edited sections sent back from the editor (after reordering steps/sections),
// so a reordered preview is what gets stored — not a re-parse of the stale text.
function sanitizeSections(arr: unknown[]): ParsedSection[] {
  const out: ParsedSection[] = [];
  for (const s of arr) {
    const sec = s as { title?: unknown; systemKey?: unknown; steps?: unknown };
    if (typeof sec.title !== "string" || !sec.title.trim()) continue;
    const systemKey = typeof sec.systemKey === "string" && KNOWN.has(sec.systemKey) ? sec.systemKey : null;
    // Drop blank steps (an added-but-unfilled line in the editor); keep leading-space indentation on
    // real ones (sub-steps).
    const steps = Array.isArray(sec.steps) ? sec.steps.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
    out.push({ seq: out.length, systemKey, title: sec.title.trim(), status: systemKey ? "automated" : "unmodeled", steps });
  }
  return out;
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { action?: unknown; text?: unknown; preview?: unknown; useAI?: unknown; sections?: unknown; kbArticle?: unknown; fromSystems?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (!isAction(body.action)) return NextResponse.json({ error: 'action must be "onboard" or "offboard"' }, { status: 422 });

  // Build the runbook FROM the modeled systems — for internal clients with no ServiceNow KB. Replaces
  // this action's sections with one per participating system (config-derived steps); editable after.
  if (body.fromSystems) {
    const client = await makeClientRepository(db).getClientBySlug(params.slug);
    if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
    const generated = sectionsFromSystems(client, body.action);
    if (!generated.length) return NextResponse.json({ error: `no systems participate in ${body.action} (set Onboard/Offboard on Edit systems first)` }, { status: 422 });
    const res = await saveRunbook(db, params.slug, body.action, "", generated);
    return NextResponse.json({ count: res?.count ?? 0, sections: res?.sections ?? [], fromSystems: true });
  }
  const text = typeof body.text === "string" ? body.text : "";
  const kbArticle = typeof body.kbArticle === "string" && /^KB\d{4,12}$/i.test(body.kbArticle.trim()) ? body.kbArticle.trim().toUpperCase() : undefined;

  // Edited sections (from a reordered preview) win — persist them verbatim.
  const edited = Array.isArray(body.sections) ? sanitizeSections(body.sections) : null;

  // Otherwise AI extraction (when requested + configured) structures messy KB HTML the heuristic
  // parser can't; fall back to the heuristic parse. The SAME sections drive preview and save.
  const aiSections = !edited && body.useAI ? await extractRunbookAI(text, body.action) : null;

  if (body.preview) {
    return NextResponse.json({ sections: edited ?? aiSections ?? parseRunbookText(text), usedAI: Boolean(aiSections) });
  }

  const res = await saveRunbook(db, params.slug, body.action, text, edited ?? aiSections ?? undefined, kbArticle);
  if (!res) return NextResponse.json({ error: "client not found" }, { status: 404 });
  return NextResponse.json({ count: res.count, sections: res.sections, usedAI: Boolean(aiSections), createdSystems: res.createdSystems });
}
