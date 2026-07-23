// GET/POST /api/admin/db-backup — read or update the nightly database-backup + restore-drill settings,
// or take a backup / run a drill right now ({ action: "run" } / { action: "drill" }). Guarded to
// settings.manage (global_admin+). A manual run does not move the nightly/weekly throttle
// (lastStartedAt) — an extra dump/drill is cheap; a skipped one is not.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { DB_BACKUP_KEY, dbBackupStatus, normalizeDbBackup, recordRunResult, runDbBackup } from "@/lib/jobs/db-backup";
import {
  DRILL_KEY, restoreDrillStatus, normalizeDrill, runRestoreDrill, pgDrillDeps,
} from "@/lib/jobs/restore-drill";
import { backupFreshness, type BackupFreshness } from "@/lib/jobs/backup-freshness";
import { loadAzureBackup } from "@/lib/jobs/backup-blob";

export const dynamic = "force-dynamic";

async function payload() {
  const [backupRaw, drillRaw, freshness] = await Promise.all([
    getAppSetting(db, DB_BACKUP_KEY),
    getAppSetting(db, DRILL_KEY),
    backupFreshness(db),
  ]);
  return {
    ...dbBackupStatus(backupRaw),
    drill: restoreDrillStatus(drillRaw),
    freshness: freshness as BackupFreshness,
  };
}

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  return NextResponse.json(await payload());
}

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  let body: { enabled?: unknown; drillEnabled?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  if (body.action === "run") {
    const s = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));
    const azure = await loadAzureBackup(db); // dark by default — no Azure call unless enabled
    const result = await runDbBackup(s, azure);
    // merge-write: a nightly claim may have landed while the dump ran — never clobber it
    await recordRunResult(db, result);
    await recordAudit(result.ok ? "db.backup.completed" : "db.backup.failed", {
      user: g.user,
      detail: { ...result, trigger: "manual" },
    });
    return NextResponse.json({ ok: result.ok, result }, { status: result.ok ? 200 : 502 });
  }

  if (body.action === "drill") {
    const azure = await loadAzureBackup(db);
    const backup = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));
    let result;
    try {
      result = await runRestoreDrill(pgDrillDeps(azure, backup.backupDir, backup.lastResult?.checksum));
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
    }
    // merge-write onto the current drill setting so a concurrent operator toggle survives
    const cur = normalizeDrill(await getAppSetting(db, DRILL_KEY));
    await setAppSetting(db, DRILL_KEY, { ...cur, lastResult: result });
    await recordAudit(result.ok ? "db.restore_drill.completed" : "db.restore_drill.failed", {
      user: g.user,
      detail: { ...result, trigger: "manual" },
    });
    return NextResponse.json({ ok: result.ok, drillResult: result }, { status: result.ok ? 200 : 502 });
  }

  if (typeof body.drillEnabled === "boolean") {
    const cur = normalizeDrill(await getAppSetting(db, DRILL_KEY));
    await setAppSetting(db, DRILL_KEY, { ...cur, enabled: body.drillEnabled });
    await recordAudit("settings.restoredrill.update", { user: g.user, detail: { enabled: body.drillEnabled } });
    return NextResponse.json({ ok: true, drillEnabled: body.drillEnabled });
  }

  // Anything that isn't an explicit boolean toggle is a client bug — reject it rather than
  // coercing a typo'd body into "disable the nightly backups".
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "expected { enabled: boolean }, { drillEnabled: boolean }, { action: \"run\" } or { action: \"drill\" }" }, { status: 422 });
  }
  const enabled = body.enabled;
  const s = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));
  await setAppSetting(db, DB_BACKUP_KEY, { ...s, enabled });
  await recordAudit("settings.dbbackup.update", { user: g.user, detail: { enabled } });
  return NextResponse.json({ ok: true, enabled });
}
