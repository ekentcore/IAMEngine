// Feature #5, §3.7 — the single "are backups fresh and restorable?" signal.
//
// Features #3 (health dashboard) and #6 (go-live readiness) BOTH consume this. They depend on its
// SHAPE, not its internals — so the staleness math lives here once and is never re-implemented in a
// consumer. Pure derivation over the two AppSettings already persisted by the backup + drill sweeps;
// no new writes.
//
// EXPORTED CONTRACT (features #3 and #6 import these):
//   backupFreshness(db: PrismaClient, now?: Date): Promise<BackupFreshness>
//   type BackupFreshness
import type { PrismaClient } from "@prisma/client";
import { getAppSetting } from "../settings";
import { DB_BACKUP_KEY, normalizeDbBackup, type DbBackupSetting } from "./db-backup";
import { DRILL_KEY, normalizeDrill, type RestoreDrillSetting } from "./restore-drill";
import { AZURE_BACKUP_KEY, resolveAzureBackup, azureConfigured, type AzureBackupSetting } from "./backup-blob";

// A backup older than this reads as stale — memory's ">26h without backup" idea, leaving slack past
// the 24h nightly cadence for a late pulse before it alerts.
export const BACKUP_STALE_HOURS = 26;
// A drill older than this reads as stale — a little over the weekly cadence.
export const DRILL_STALE_DAYS = 8;

export type BackupFreshness = {
  lastBackupAt: string | null;
  backupOk: boolean; // last dump succeeded
  backupAgeHours: number | null;
  backupStale: boolean; // no successful backup within BACKUP_STALE_HOURS

  lastUploadAt: string | null;
  blobOk: boolean; // off-box copy present + fresh (true when Azure upload is not enabled — not required pre-cutover)

  lastDrillAt: string | null;
  drillOk: boolean; // last restore drill passed all integrity assertions
  drillAgeDays: number | null;
  drillStale: boolean; // no successful drill within DRILL_STALE_DAYS

  healthy: boolean; // backupOk && !backupStale && blobOk && drillOk && !drillStale
};

const ageHours = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 3_600_000 : null;
};

// Pure core — fully testable with plain setting objects, no DB. Consumers use backupFreshness().
export function computeFreshness(
  backup: DbBackupSetting,
  drill: RestoreDrillSetting,
  azureEnabled: boolean,
  now: Date,
): BackupFreshness {
  const b = backup.lastResult;
  const lastBackupAt = b?.at ?? null;
  const backupOk = Boolean(b?.ok);
  const backupAgeHours = ageHours(lastBackupAt, now);
  // No successful backup at all, or older than the window (an unparseable/absent stamp is stale).
  const backupStale = !backupOk || backupAgeHours === null || backupAgeHours > BACKUP_STALE_HOURS;

  const lastUploadAt = b?.blobUploadedAt ?? null;
  const uploadAge = ageHours(lastUploadAt, now);
  // Off-box copy is only REQUIRED once the Azure upload is switched on; while it is dark, blobOk is
  // true so the freshness signal doesn't fail health for a feature that is intentionally inert.
  const blobOk = !azureEnabled
    ? true
    : Boolean(b?.blobUploadedAt) && !b?.uploadError && uploadAge !== null && uploadAge <= BACKUP_STALE_HOURS;

  const d = drill.lastResult;
  const lastDrillAt = d?.at ?? null;
  const drillOk = Boolean(d?.ok);
  const drillAgeHours = ageHours(lastDrillAt, now);
  const drillAgeDays = drillAgeHours === null ? null : drillAgeHours / 24;
  const drillStale = !drillOk || drillAgeDays === null || drillAgeDays > DRILL_STALE_DAYS;

  const healthy = backupOk && !backupStale && blobOk && drillOk && !drillStale;

  return {
    lastBackupAt, backupOk, backupAgeHours, backupStale,
    lastUploadAt, blobOk,
    lastDrillAt, drillOk, drillAgeDays, drillStale,
    healthy,
  };
}

// The read #3 and #6 call. Reads the backup + drill + azure AppSettings and derives the signal.
export async function backupFreshness(db: PrismaClient, now: Date = new Date()): Promise<BackupFreshness> {
  const [backupRaw, drillRaw, azureRaw] = await Promise.all([
    getAppSetting<unknown>(db, DB_BACKUP_KEY),
    getAppSetting<unknown>(db, DRILL_KEY),
    getAppSetting<AzureBackupSetting>(db, AZURE_BACKUP_KEY),
  ]);
  const azure = resolveAzureBackup(azureRaw);
  return computeFreshness(normalizeDbBackup(backupRaw), normalizeDrill(drillRaw), azureConfigured(azure), now);
}
