// POST /api/clients/:slug/runbook — { action, text } parse a pasted runbook into RunbookSection
// rows for clients with no ServiceNow KB. GET (?action=) previews the parse without saving.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import type { Action } from "@prisma/client";
import { db } from "@/lib/db";
import { saveRunbook } from "@/lib/clients/runbook-repo";
import { parseRunbookText } from "@/lib/clients/runbook-parse";

export const dynamic = "force-dynamic";

const isAction = (a: unknown): a is Action => a === "onboard" || a === "offboard";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  let body: { action?: unknown; text?: unknown; preview?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (!isAction(body.action)) return NextResponse.json({ error: 'action must be "onboard" or "offboard"' }, { status: 422 });
  const text = typeof body.text === "string" ? body.text : "";

  // Preview: parse only, don't persist (drives the live preview in the editor).
  if (body.preview) return NextResponse.json({ sections: parseRunbookText(text) });

  const res = await saveRunbook(db, params.slug, body.action, text);
  if (!res) return NextResponse.json({ error: "client not found" }, { status: 404 });
  return NextResponse.json({ count: res.count, sections: res.sections });
}
