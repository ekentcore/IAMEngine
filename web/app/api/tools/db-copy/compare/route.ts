// POST /api/tools/db-copy/compare — read-only verification: EXACT per-table row counts for the source
// vs the destination in the form, so you can confirm a copy landed (no truncate, no write). Source is
// this app's DB (POSTGRES_*); destination comes from the form body (+ password, transient). Guard
// settings.manage. Excludes the Prisma migration ledger (same as the copy).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { readCopyConfigs } from "@/lib/db-copy/config";
import { compareTables } from "@/lib/db-copy/copy";
import { connFromProfile, normalizeProfileInput } from "@/lib/db-copy/dest-profile";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  let cfg;
  try {
    cfg = readCopyConfigs();
  } catch (e) {
    return NextResponse.json({ ok: false as const, error: `could not read source config (env.env): ${msg(e)}` }, { status: 400 });
  }
  if (!cfg.source) return NextResponse.json({ ok: false as const, error: `source not configured (missing: ${cfg.missingSource.join(", ")})` }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const norm = normalizeProfileInput(body);
  if (!norm.ok) return NextResponse.json({ ok: false as const, error: `destination missing: ${norm.missing.join(", ")}` }, { status: 400 });
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return NextResponse.json({ ok: false as const, error: "destination password is required" }, { status: 400 });
  const dest = connFromProfile(norm.profile, password);

  try {
    const comparison = await compareTables(cfg.source, dest);
    return NextResponse.json({ ok: true as const, comparison });
  } catch (e) {
    return NextResponse.json({ ok: false as const, error: msg(e) }, { status: 200 });
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
