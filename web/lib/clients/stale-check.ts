// "Auto-refresh when stale" without a cron job: the list view calls this, and if the most
// recent ServiceNow sync is older than the threshold (or never ran), it triggers one.
import type { PrismaClient } from "@prisma/client";
import { runSnSync } from "./sync-runner";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

export async function isSnSyncStale(db: PrismaClient): Promise<boolean> {
  const latest = await db.client.findFirst({
    where: { snLastSyncedAt: { not: null } },
    orderBy: { snLastSyncedAt: "desc" },
    select: { snLastSyncedAt: true },
  });
  if (!latest?.snLastSyncedAt) return true;
  return Date.now() - latest.snLastSyncedAt.getTime() > STALE_THRESHOLD_MS;
}

// Best-effort: never let a sync failure break the page render — log and move on.
export async function syncIfStale(db: PrismaClient, actor: string): Promise<void> {
  try {
    if (await isSnSyncStale(db)) await runSnSync(db, actor);
  } catch (err) {
    console.error("[stale-check] ServiceNow sync skipped:", err);
  }
}
