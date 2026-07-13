// GET/POST /api/admin/db-backup — read or update the nightly database-backup setting, or take a
// backup right now ({ action: "run" }). Guarded to settings.manage (global_admin+). A manual run
// does not move the nightly throttle (lastStartedAt) — an extra dump is cheap; a skipped night
// is not.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { DB_BACKUP_KEY, defaultBackupDir, normalizeDbBackup, runDbBackup } from "@/lib/jobs/db-backup";

export const dynamic = "force-dynamic";

function summarize(s: ReturnType<typeof normalizeDbBackup>) {
  return {
    enabled: s.enabled,
    hourLocal: s.hourLocal ?? 2,
    keepDays: s.keepDays ?? 30,
    backupDir: s.backupDir ?? defaultBackupDir(),
    lastStartedAt: s.lastStartedAt ?? null,
    lastResult: s.lastResult ?? null,
  };
}

export async function GET() {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  const s = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));
  return NextResponse.json(summarize(s));
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

  const s = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));

  if (body.action === "run") {
    const result = await runDbBackup(s);
    await setAppSetting(db, DB_BACKUP_KEY, { ...s, lastResult: result });
    await db.auditLog
      .create({
        data: {
          actor: "system:db-backup",
          action: result.ok ? "db.backup.completed" : "db.backup.failed",
          detail: { ...result, trigger: "manual", by: g.user?.email ?? null },
        },
      })
      .catch(() => {});
    return NextResponse.json({ ok: result.ok, result }, { status: result.ok ? 200 : 502 });
  }

  const enabled = body.enabled === true;
  await setAppSetting(db, DB_BACKUP_KEY, { ...s, enabled });
  await recordAudit("settings.dbbackup.update", { user: g.user, detail: { enabled } });
  return NextResponse.json({ ok: true, enabled });
}
