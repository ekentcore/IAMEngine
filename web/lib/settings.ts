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
