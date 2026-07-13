// App-level singleton key/value settings (the AppSetting table). JSON-as-text values. Used by the
// ServiceNow intake poller for its enabled flag + high-water mark; reusable for future app flags.
import type { PrismaClient } from "@prisma/client";

export async function getAppSetting<T = unknown>(db: PrismaClient, key: string): Promise<T | null> {
  const row = await db.appSetting.findUnique({ where: { key } });
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}

export async function setAppSetting(db: PrismaClient, key: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value);
  await db.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

// Race-safe conditional claim for sweep-style periodic tasks: persist `next` only if the row
// still holds exactly `expected` (the value the caller just read). The condition lives in the
// WHERE clause — a read-compare-write inside a transaction is NOT enough under READ COMMITTED,
// where two processes can both pass the compare and both write. `expected` must be the parsed
// value from getAppSetting; JSON.parse→JSON.stringify round-trips to the stored text byte-for-byte.
export async function claimAppSetting(db: PrismaClient, key: string, expected: unknown, next: unknown): Promise<boolean> {
  const v = JSON.stringify(next);
  try {
    if (expected === null || expected === undefined) {
      // No row yet: claim by creating it — a racing creator loses on the unique key.
      await db.appSetting.create({ data: { key, value: v } });
      return true;
    }
    const res = await db.appSetting.updateMany({ where: { key, value: JSON.stringify(expected) }, data: { value: v } });
    return res.count === 1;
  } catch {
    return false;
  }
}

// The intake poller's stored state.
export const INTAKE_SETTING_KEY = "servicenow_intake_poll";
export type IntakeSetting = {
  enabled: boolean;
  lastRunAt?: string;          // ISO — last time the sweep ran (auto or manual "Import now")
  lastImportedNumber?: string; // most recent UM/INC number imported (for the log)
  imported?: number;           // running count imported by the poller (cumulative)
  lastRunScanned?: number;     // open/unassigned tickets seen on the most recent run
  lastRunImported?: number;    // NEW cases imported on the most recent run
};
