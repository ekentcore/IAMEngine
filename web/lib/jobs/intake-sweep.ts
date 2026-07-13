// Automated ServiceNow intake: every ~15 min, pull OPEN/UNASSIGNED in-scope UM tickets + internal
// on/off-boarding INCIDENTS and auto-import + plan any not already imported (left HELD for review —
// nothing runs unattended). First run sweeps the current backlog; thereafter it catches new tickets.
// Dedupe is by CaseRequest.serviceNowCaseNumber (@unique) via importByNumber, so re-polls never
// double-create. Off by default (the enabled flag in AppSetting); hooked into the heartbeat sweep
// cadence like procurement watches. The same sweep runs on demand via runIntakeSweepNow ("Import now").
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv } from "../servicenow/gateway";
import { assertConfig } from "../servicenow/http";
import { fetchOpenIntakeNumbers, fetchOpenIncidentNumbers } from "../servicenow/intake-list";
import { importByNumber } from "../cases/import-service";
import { getAppSetting, setAppSetting, INTAKE_SETTING_KEY, type IntakeSetting } from "../settings";

const POLL_EVERY_MS = 15 * 60 * 1000; // 15 minutes
let lastRunAt = 0; // in-process throttle so concurrent heartbeats don't stack runs

export type IntakeSweepResult = { scanned: number; imported: number; alreadyImported: number; skipped: number; failed: number };

// One sweep: fetch open/unassigned UMs + lifecycle INCs, import the new ones (idempotent, HELD), and
// record the run on the AppSetting. Preserves the `enabled` flag (a manual run never flips it). Shared
// by the throttled poller and the on-demand "Import now" trigger. Throws if SN isn't configured.
async function sweepOnce(db: PrismaClient, actor: string, setting: IntakeSetting): Promise<IntakeSweepResult> {
  const config = snConfigFromEnv();
  assertConfig(config); // throws when SN isn't configured — callers decide whether to surface or swallow

  let importedTotal = setting.imported ?? 0;
  let lastNumber = setting.lastImportedNumber;
  const res: IntakeSweepResult = { scanned: 0, imported: 0, alreadyImported: 0, skipped: 0, failed: 0 };

  // UM external client tickets + internal on/off-boarding incidents. importByNumber routes each by
  // prefix (INC→incident path, UM→user-management path) and dedupes by serviceNowCaseNumber.
  const [ums, incs] = await Promise.all([fetchOpenIntakeNumbers(config), fetchOpenIncidentNumbers(config)]);
  const numbers = [...ums, ...incs];
  res.scanned = numbers.length;
  for (const number of numbers) {
    // importByNumber is idempotent (dedupes by serviceNowCaseNumber) and leaves the case HELD.
    const r = await importByNumber(db, number, actor).catch(() => null);
    // A "do not use engine" client's ticket is deliberate, not a failure — count it apart so the
    // run summary doesn't read as broken.
    if (r && !r.ok && r.code === "engine_opt_out") { res.skipped++; continue; }
    if (!r || !(r as { ok?: boolean }).ok) { res.failed++; continue; }
    if ((r as { alreadyImported?: boolean }).alreadyImported) { res.alreadyImported++; continue; }
    res.imported++; importedTotal++; lastNumber = number;
  }

  await setAppSetting(db, INTAKE_SETTING_KEY, {
    ...setting,
    lastRunAt: new Date().toISOString(),
    imported: importedTotal,
    lastImportedNumber: lastNumber,
    lastRunScanned: res.scanned,
    lastRunImported: res.imported,
  });
  return res;
}

// Heartbeat-driven poller: throttled to ~15 min and gated on the enabled flag. Swallows a SN outage /
// unconfigured env (next sweep retries).
export async function sweepServiceNowIntake(db: PrismaClient): Promise<void> {
  const now = Date.now();
  if (now - lastRunAt < POLL_EVERY_MS) return;
  lastRunAt = now;

  const setting = (await getAppSetting<IntakeSetting>(db, INTAKE_SETTING_KEY)) ?? { enabled: false };
  if (!setting.enabled) return;

  try { await sweepOnce(db, "system:intake-poll", setting); }
  catch { /* transient SN error / not configured — leave state; next sweep retries. */ }
}

// On-demand sweep ("Import now"): runs immediately regardless of the throttle or the enabled flag (an
// explicit operator action), and resets the in-process throttle so the next auto-poll waits its full
// interval. Returns the run summary for UI feedback; surfaces a SN-config error to the caller.
export async function runIntakeSweepNow(db: PrismaClient, actor: string): Promise<IntakeSweepResult> {
  const setting = (await getAppSetting<IntakeSetting>(db, INTAKE_SETTING_KEY)) ?? { enabled: false };
  const result = await sweepOnce(db, actor, setting);
  lastRunAt = Date.now();
  return result;
}
