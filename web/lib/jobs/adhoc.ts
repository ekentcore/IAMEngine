// Ad-hoc operator actions that ride the Job table but are NOT case work: password resets
// (INC0855142) and the on-demand "force Spanning sync". They must be invisible to the case
// status/dependency machinery — a failed one must not fail the case, a pending one must not read as
// "still running", and one must never gate a real step. Centralized here so every derivation
// (runner-logic, gating, status) filters the SAME set; extend this when a new ad-hoc action is added.
import type { Prisma } from "@prisma/client";
import { PASSWORD_RESET_SYSTEM_KEYS } from "./password-reset";

// The systemKey a "force Spanning sync" job runs under. Distinct from the planned "spanning" line so
// the case machinery never confuses the ad-hoc browser action with the real backup-license step.
export const SPANNING_FORCE_SYNC_KEY = "spanning-force-sync";

export const ADHOC_SYSTEM_KEYS = [...new Set([...PASSWORD_RESET_SYSTEM_KEYS, SPANNING_FORCE_SYNC_KEY])];

export function isAdhocSystemKey(systemKey: string): boolean {
  return ADHOC_SYSTEM_KEYS.includes(systemKey);
}

// The closing step that must always remain the LAST step on a case. The planner places it last (the
// runLast rule in the orchestrator), but post-plan inserts — force Spanning sync, ad-hoc password
// reset, ad-hoc hard match — append at max(sequence)+1, which lands them AFTER it, so the case ends on
// a "Case resolution" step that isn't actually last.
export const CLOSING_SYSTEM_KEY = "case-resolution";

// Sequence for a NEWLY-inserted post-plan step so it lands JUST ABOVE the case-resolution step,
// pushing case-resolution (and anything after it) down by one — so case-resolution stays last and the
// new step reads as "step N, then Case resolution" instead of after it. Falls back to a plain append
// (max+1) when the case has no case-resolution step. MUST run inside the same transaction as the
// job.create so the shift and the insert commit atomically. There is no (caseRequestId, sequence)
// unique constraint, so shifting the trailing rows up by one can't collide.
export async function insertStepSequence(tx: Prisma.TransactionClient, caseRequestId: string): Promise<number> {
  const closing = await tx.job.findFirst({
    where: { caseRequestId, systemKey: CLOSING_SYSTEM_KEY },
    orderBy: { sequence: "asc" },
    select: { sequence: true },
  });
  if (!closing) {
    const agg = await tx.job.aggregate({ where: { caseRequestId }, _max: { sequence: true } });
    return (agg._max.sequence ?? 0) + 1;
  }
  await tx.job.updateMany({
    where: { caseRequestId, sequence: { gte: closing.sequence } },
    data: { sequence: { increment: 1 } },
  });
  return closing.sequence;
}
