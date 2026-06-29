// Automated ServiceNow intake: every ~15 min, pull OPEN/UNASSIGNED in-scope UM tickets and auto-import
// + plan any not already imported (left HELD for review — nothing runs unattended). First run sweeps the
// current backlog; thereafter it catches new tickets. Dedupe is by CaseRequest.serviceNowCaseNumber
// (@unique) via importByNumber, so re-polls never double-create. Off by default (the enabled flag in
// AppSetting); hooked into the heartbeat sweep cadence like procurement watches.
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv } from "../servicenow/gateway";
import { assertConfig } from "../servicenow/http";
import { fetchOpenIntakeNumbers } from "../servicenow/intake-list";
import { importByNumber } from "../cases/import-service";
import { getAppSetting, setAppSetting, INTAKE_SETTING_KEY, type IntakeSetting } from "../settings";

const POLL_EVERY_MS = 15 * 60 * 1000; // 15 minutes
let lastRunAt = 0; // in-process throttle so concurrent heartbeats don't stack runs

export async function sweepServiceNowIntake(db: PrismaClient): Promise<void> {
  const now = Date.now();
  if (now - lastRunAt < POLL_EVERY_MS) return;
  lastRunAt = now;

  const setting = (await getAppSetting<IntakeSetting>(db, INTAKE_SETTING_KEY)) ?? { enabled: false };
  if (!setting.enabled) return;

  const config = snConfigFromEnv();
  try { assertConfig(config); } catch { return; } // SN not configured — skip quietly

  let imported = setting.imported ?? 0;
  let lastNumber = setting.lastImportedNumber;
  try {
    const numbers = await fetchOpenIntakeNumbers(config);
    for (const number of numbers) {
      // importByNumber is idempotent (dedupes by serviceNowCaseNumber) and leaves the case HELD.
      const res = await importByNumber(db, number, "system:intake-poll").catch(() => null);
      if (res && (res as { ok?: boolean }).ok && !(res as { alreadyImported?: boolean }).alreadyImported) {
        imported++; lastNumber = number;
      }
    }
  } catch {
    // transient SN error — leave state; next sweep retries.
  }
  await setAppSetting(db, INTAKE_SETTING_KEY, { ...setting, enabled: true, lastRunAt: new Date(now).toISOString(), imported, lastImportedNumber: lastNumber });
}
