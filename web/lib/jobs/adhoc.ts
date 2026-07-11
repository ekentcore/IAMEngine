// Ad-hoc operator actions that ride the Job table but are NOT case work: password resets
// (INC0855142) and the on-demand "force Spanning sync". They must be invisible to the case
// status/dependency machinery — a failed one must not fail the case, a pending one must not read as
// "still running", and one must never gate a real step. Centralized here so every derivation
// (runner-logic, gating, status) filters the SAME set; extend this when a new ad-hoc action is added.
import { PASSWORD_RESET_SYSTEM_KEYS } from "./password-reset";

// The systemKey a "force Spanning sync" job runs under. Distinct from the planned "spanning" line so
// the case machinery never confuses the ad-hoc browser action with the real backup-license step.
export const SPANNING_FORCE_SYNC_KEY = "spanning-force-sync";

export const ADHOC_SYSTEM_KEYS = [...new Set([...PASSWORD_RESET_SYSTEM_KEYS, SPANNING_FORCE_SYNC_KEY])];

export function isAdhocSystemKey(systemKey: string): boolean {
  return ADHOC_SYSTEM_KEYS.includes(systemKey);
}
