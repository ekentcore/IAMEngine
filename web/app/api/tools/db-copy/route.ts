// GET  /api/tools/db-copy — hydrate the form: source identity + the saved (non-secret) destination
//                           profile. No live connection (the form has no password yet).
// POST /api/tools/db-copy — run the copy from the source (POSTGRES_*) into the destination described
//                           by the request body (typed in the form; password included for this call
//                           only). Keeps the typed-DB-name confirmation and the self-copy refusal.
//
// Extremely privileged: it clones the entire operational database (Delinea secret REFERENCES, every
// client, case, job and audit row) into another database. Gated on settings.manage (super_admin /
// global_admin only). The destination PASSWORD is never persisted — only the non-secret profile is.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { readCopyConfigs, connLabel, type PgConn } from "@/lib/db-copy/config";
import { runCopy, copyAuditDetail } from "@/lib/db-copy/copy";
import { getDestProfile, saveDestProfile, connFromProfile, pickProfile, normalizeProfileInput } from "@/lib/db-copy/dest-profile";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const src = readSourceSafely();
  const destProfile = await getDestProfile(db);
  return NextResponse.json({
    ok: true as const,
    source: "error" in src ? { error: src.error } : { label: connLabel(src.source) },
    destProfile, // may be null → the form falls back to env.env POSTGRES_*1 hint client-side
  });
}

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const src = readSourceSafely();
  if ("error" in src) return NextResponse.json({ ok: false as const, error: src.error }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const norm = normalizeProfileInput(body);
  if (!norm.ok) return NextResponse.json({ ok: false as const, error: `destination missing: ${norm.missing.join(", ")}` }, { status: 400 });
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return NextResponse.json({ ok: false as const, error: "destination password is required" }, { status: 400 });
  const dest = connFromProfile(norm.profile, password);

  const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";
  if (confirm !== dest.database) {
    return NextResponse.json(
      { ok: false as const, error: `type the destination database name ("${dest.database}") to confirm` },
      { status: 400 },
    );
  }

  // Remember the non-secret profile so the form pre-fills next time (never the password).
  await saveDestProfile(db, pickProfile(dest));

  try {
    const result = await runCopy(src.source, dest);
    // Audit the SUCCESS: who (g.user), where (source→dest), and how much/how long.
    await recordAudit("db_copy.run", {
      user: g.user,
      detail: copyAuditDetail(src.source, dest, { ok: true, tables: result.tables, durationMs: result.durationMs }),
    });
    return NextResponse.json({ ok: true as const, result });
  } catch (e) {
    const error = msg(e);
    // Audit the FAILURE too: who, where, and WHY (error scrubbed of both passwords).
    await recordAudit("db_copy.failed", {
      user: g.user,
      detail: copyAuditDetail(src.source, dest, { ok: false, error }),
    });
    return NextResponse.json({ ok: false as const, error }, { status: 200 });
  }
}

/** The source is always this app's own DB (POSTGRES_*). Never throws — reports a config problem. */
function readSourceSafely(): { source: PgConn } | { error: string } {
  let cfg;
  try {
    cfg = readCopyConfigs();
  } catch (e) {
    return { error: `could not read source config (env.env): ${msg(e)}` };
  }
  if (!cfg.source) return { error: `source not configured (missing: ${cfg.missingSource.join(", ")})` };
  return { source: cfg.source };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
