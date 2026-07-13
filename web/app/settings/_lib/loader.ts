// Shared server-side loader for the Settings pages (/settings and /settings/v2 — keep both thin).
import { db } from "@/lib/db";
import { getAppSetting } from "@/lib/settings";
import { DB_BACKUP_KEY, defaultBackupDir, normalizeDbBackup } from "@/lib/jobs/db-backup";
import type { FeatureRequestRow } from "../_components/feature-requests-admin";
import type { DbBackupStatus } from "../_components/db-backup-card";

export async function loadDbBackupStatus(): Promise<DbBackupStatus> {
  const s = normalizeDbBackup(await getAppSetting(db, DB_BACKUP_KEY));
  return {
    enabled: s.enabled,
    hourLocal: s.hourLocal ?? 2,
    keepDays: s.keepDays ?? 30,
    backupDir: s.backupDir ?? defaultBackupDir(),
    lastResult: s.lastResult ?? null,
  };
}

export async function loadFeatureRequests(): Promise<FeatureRequestRow[]> {
  const rows = await db.featureRequest.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    page: r.page,
    status: r.status,
    resolutionNote: r.resolutionNote,
    authorEmail: r.authorEmail,
    createdAt: r.createdAt.toISOString(),
  }));
}
