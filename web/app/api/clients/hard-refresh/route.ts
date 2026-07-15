// POST /api/clients/hard-refresh — bulk force-overwrite selected clients from ServiceNow,
// discarding their manual edits. Body: { slugs: string[] }.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { auditActor } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { hardRefreshClients } from "@/lib/clients/hard-refresh";

export const dynamic = "force-dynamic";

const MAX = 200;

export async function POST(req: Request) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  let body: { slugs?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (!Array.isArray(body.slugs) || body.slugs.some((s) => typeof s !== "string")) {
    return NextResponse.json({ error: "slugs[] (strings) is required" }, { status: 422 });
  }
  const slugs = [...new Set((body.slugs as string[]).map((s) => s.trim()).filter(Boolean))].slice(0, MAX);
  if (slugs.length === 0) return NextResponse.json({ error: "no slugs given" }, { status: 422 });

  const results = await hardRefreshClients(db, slugs, auditActor(_g.user, "ui:bulk"));
  return NextResponse.json({
    results,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
}
