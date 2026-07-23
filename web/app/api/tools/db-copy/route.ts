// GET  /api/tools/db-copy — preview what a copy would do (config validity + per-table presence/rows).
// POST /api/tools/db-copy — run the copy from POSTGRES_* (source) into POSTGRES_*1 (destination).
//
// Extremely privileged: it clones the entire operational database (including Delinea secret
// REFERENCES, every client, case, job and audit row) into another database. Gated on settings.manage
// (super_admin / global_admin only), and the POST requires a typed confirmation matching the
// destination database name so it can't be triggered by accident.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { readCopyConfigs } from "@/lib/db-copy/config";
import { previewCopy, runCopy, checkConnections } from "@/lib/db-copy/copy";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const cfg = readCopyConfigsSafely();
  if ("error" in cfg) return NextResponse.json(cfg, { status: 200 }); // a config problem is shown in-page, not a 500
  try {
    // Health-test both connections first, so the page can show per-database status. Only build the
    // (heavier) table preview when both sides are actually reachable.
    const health = await checkConnections(cfg.source, cfg.dest);
    if (!health.source.ok || !health.dest.ok) {
      return NextResponse.json({ ok: true as const, health, preview: null });
    }
    const preview = await previewCopy(cfg.source, cfg.dest);
    return NextResponse.json({ ok: true as const, health, preview });
  } catch (e) {
    return NextResponse.json({ ok: false as const, error: msg(e) }, { status: 200 });
  }
}

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  const cfg = readCopyConfigsSafely();
  if ("error" in cfg) return NextResponse.json(cfg, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { confirm?: unknown };
  const confirm = typeof body.confirm === "string" ? body.confirm.trim() : "";
  if (confirm !== cfg.dest.database) {
    return NextResponse.json(
      { ok: false as const, error: `type the destination database name ("${cfg.dest.database}") to confirm` },
      { status: 400 },
    );
  }

  try {
    const result = await runCopy(cfg.source, cfg.dest);
    await recordAudit("db_copy.run", {
      user: g.user,
      detail: {
        source: `${cfg.source.host}:${cfg.source.port}/${cfg.source.database}`,
        dest: `${cfg.dest.host}:${cfg.dest.port}/${cfg.dest.database}`,
        totalTables: result.totalTables,
        created: result.createdTables.length,
        truncated: result.truncatedTables.length,
        durationMs: result.durationMs,
      },
    });
    return NextResponse.json({ ok: true as const, result });
  } catch (e) {
    return NextResponse.json({ ok: false as const, error: msg(e) }, { status: 200 });
  }
}

function readCopyConfigsSafely() {
  let cfg;
  try {
    cfg = readCopyConfigs();
  } catch (e) {
    return { error: `could not read env.env: ${msg(e)}` };
  }
  const problems: string[] = [];
  if (!cfg.source) problems.push(`source not configured (missing: ${cfg.missingSource.join(", ")})`);
  if (!cfg.dest) problems.push(`destination not configured (missing: ${cfg.missingDest.join(", ")})`);
  if (problems.length || !cfg.source || !cfg.dest) return { error: problems.join("; ") || "connection config incomplete" };
  return { source: cfg.source, dest: cfg.dest };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
