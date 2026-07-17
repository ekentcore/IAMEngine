// Shared server-side loader for the Settings pages (/settings and /settings/v2 — keep both thin).
import { db } from "@/lib/db";
import { getAppSetting } from "@/lib/settings";
import { DB_BACKUP_KEY, dbBackupStatus, type DbBackupStatus } from "@/lib/jobs/db-backup";

export async function loadDbBackupStatus(): Promise<DbBackupStatus> {
  return dbBackupStatus(await getAppSetting(db, DB_BACKUP_KEY));
}

// Every request, newest number first — hidden ones included. The caller splits them: `hidden` rows
// go to the collapsed Completed table, the rest stay on the board.
