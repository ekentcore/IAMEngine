// POST /api/clients/:slug/runbook — { action, text } parse a pasted runbook into RunbookSection
// rows for clients with no ServiceNow KB. GET (?action=) previews the parse without saving.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import type { Action } from "@prisma/client";
import { db } from "@/lib/db";
import { saveRunbook } from "@/lib/clients/runbook-repo";
import { parseRunbookText } from "@/lib/clients/runbook-parse";
import { extractRunbookAI } from "@/lib/clients/runbook-extract";

export const dynamic = "force-dynamic";

const isAction = (a: unknown): a is Action => a === "onboard" || a === "offboard";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  let body: { action?: unknown; text?: unknown; preview?: unknown; useAI?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (!isAction(body.action)) return NextResponse.json({ error: 'action must be "onboard" or "offboard"' }, { status: 422 });
  const text = typeof body.text === "string" ? body.text : "";

  // AI extraction (when requested + configured) structures messy KB HTML the heuristic parser can't;
  // fall back to the heuristic parse otherwise. The SAME sections drive both the preview and the
  // save, so what you preview is exactly what gets stored.
  const aiSections = body.useAI ? await extractRunbookAI(text, body.action) : null;

  if (body.preview) {
    return NextResponse.json({ sections: aiSections ?? parseRunbookText(text), usedAI: Boolean(aiSections) });
  }

  const res = await saveRunbook(db, params.slug, body.action, text, aiSections ?? undefined);
  if (!res) return NextResponse.json({ error: "client not found" }, { status: 404 });
  return NextResponse.json({ count: res.count, sections: res.sections, usedAI: Boolean(aiSections) });
}
