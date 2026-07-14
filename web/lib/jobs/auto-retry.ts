// The auto-retry decision, as a pure function — shared by recordResult (which schedules the next
// wait) and requeueJob (which carries the attempt budget across the re-queue).
//
// An executor that is waiting on a VENDOR-SIDE sync (Spanning/Mimecast discovering a freshly-created
// M365 user) returns success plus RetryAfterMinutes: "nothing is wrong, ask me again shortly". The
// app then re-queues the job when the wait is due. Two things about that were broken:
//
//   1. The attempt cap never bit. requeueJob deleted the whole autoRetry marker, so the count reset
//      to 0 on every re-queue and `count < MAX` was always true — a user the vendor will NEVER
//      discover (e.g. an unlicensed M365 user, who has no mailbox to sync) retried every 15 minutes
//      forever. The count now survives the re-queue, so the budget is real.
//   2. A waiting step was reported as a warning. That's what `scheduled` is for: while a retry is
//      pending the step is benignly "retrying", so it writes no run-log row and raises no chat alert.
//      When the budget runs out it becomes `exhausted` — the wait is over, it never resolved, and the
//      operator finally sees a warning that means something.

export const MAX_AUTO_RETRIES = 16; // ~4h at the executors' 15-minute cadence

export type AutoRetryMarker = { at?: number; count?: number; firstAt?: number };

export type AutoRetryDecision =
  | { kind: "scheduled"; marker: Required<AutoRetryMarker> }
  | { kind: "resolved"; attempts: number; elapsedMinutes: number | null }
  | { kind: "exhausted"; attempts: number; elapsedMinutes: number | null }
  | { kind: "none" };

const elapsed = (firstAt: number | undefined, now: number): number | null =>
  firstAt ? Math.round((now - firstAt) / 60_000) : null;

/**
 * @param prev the marker already on the job's request (null on the first run)
 * @param mins RetryAfterMinutes from this result (0 / absent = the executor is done waiting)
 */
export function decideAutoRetry(prev: AutoRetryMarker | null, mins: number, now: number, max = MAX_AUTO_RETRIES): AutoRetryDecision {
  const attempts = prev?.count ?? 0;
  if (mins > 0 && attempts < max) {
    return { kind: "scheduled", marker: { at: now + mins * 60_000, count: attempts + 1, firstAt: prev?.firstAt ?? now } };
  }
  if (!prev) return { kind: "none" }; // never waited, isn't waiting now
  // The executor stopped asking for more time: the wait ended on its own.
  if (mins <= 0) return { kind: "resolved", attempts, elapsedMinutes: elapsed(prev.firstAt, now) };
  // It still wants to wait, but the budget is spent. Give up and let it warn.
  return { kind: "exhausted", attempts, elapsedMinutes: elapsed(prev.firstAt, now) };
}

/**
 * What to put back on the request when an AUTOMATIC retry re-queues the job: the attempt budget,
 * but never `at` — the job is about to run, so it isn't "scheduled for later", and a stale `at`
 * would make the run report advertise a next-try time for a step that is executing right now.
 * An operator-driven re-run passes nothing here: a human stepping in starts the budget over.
 */
export function carriedRetryMarker(prev: AutoRetryMarker | null, now: number): AutoRetryMarker | null {
  if (!prev) return null;
  return { count: prev.count ?? 0, firstAt: prev.firstAt ?? now };
}
