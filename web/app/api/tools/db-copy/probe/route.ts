// POST /api/tools/db-copy/probe — staged connection test for both source and destination.
// Body: the destination fields + password (typed in the form). Source is this app's own DB
// (POSTGRES_*). Runs the ordered probe on both, side-effect-saves the non-secret dest profile, and —
// when both sides come up green — includes the copy preview so the form can show what a copy would do.
// The password is never persisted, logged, or echoed (probe scrubs it). Guard settings.manage.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { readCopyConfigs } from "@/lib/db-copy/config";
import { previewCopy } from "@/lib/db-copy/copy";
import { probeConnections } from "@/lib/db-copy/probe";
import { saveDestProfile, connFromProfile, normalizeProfileInput } from "@/lib/db-copy/dest-profile";

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

  // Remember the non-secret profile as soon as a probe is attempted (never the password).
  await saveDestProfile(db, norm.profile);

  const probe = await probeConnections(cfg.source, dest);

  // Only build the (heavier) table preview when both sides are actually reachable.
  let preview = null;
  if (probe.source.ok && probe.dest.ok) {
    try {
      preview = await previewCopy(cfg.source, dest);
    } catch {
      preview = null; // a preview failure shouldn't mask a successful probe
    }
  }

  return NextResponse.json({ ok: true as const, probe, preview });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
