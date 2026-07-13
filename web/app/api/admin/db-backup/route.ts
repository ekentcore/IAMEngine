// GET/POST /api/admin/db-backup — read or update the nightly database-backup setting, or take a
// backup right now ({ action: "run" }). Guarded to settings.manage (global_admin+). A manual run
// does not move the nightly throttle (lastStartedAt) — an extra dump is cheap; a skipped night
// is not.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { DB_BACKUP_KEY, dbBackupStatus, normalizeDbBackup, recordRunResult, runDbBackup } from "@/lib/jobs/db-backup";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  return NextResponse.json(dbBackupStatus(await getAppSetting(db, DB_BACKUP_KEY)));
}

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  let body: { enabled?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  if (body.action === "run") {
    const s = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));
    const result = await runDbBackup(s);
    // merge-write: a nightly claim may have landed while the dump ran — never clobber it
    await recordRunResult(db, result);
    await recordAudit(result.ok ? "db.backup.completed" : "db.backup.failed", {
      user: g.user,
      detail: { ...result, trigger: "manual" },
    });
    return NextResponse.json({ ok: result.ok, result }, { status: result.ok ? 200 : 502 });
  }

  // Anything that isn't an explicit boolean toggle is a client bug — reject it rather than
  // coercing a typo'd body into "disable the nightly backups".
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "expected { enabled: boolean } or { action: \"run\" }" }, { status: 422 });
  }
  const enabled = body.enabled;
  const s = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));
  await setAppSetting(db, DB_BACKUP_KEY, { ...s, enabled });
  await recordAudit("settings.dbbackup.update", { user: g.user, detail: { enabled } });
  return NextResponse.json({ ok: true, enabled });
}
