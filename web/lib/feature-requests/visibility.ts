// When a request leaves the board. "Hidden" is DERIVED from hideAt (hideAt <= now), never stored as
// a flag and never flipped by a sweep — this app has no cron, and the heartbeat pulse it fakes one
// with only ticks while a runner is beating, so a quiet fleet would stall the 7-day timer. A
// timestamp compared at read time cannot stall: the request hides on its own at exactly hideAt.
//
//   status -> done      arm the timer: hideAt = now + 7d
//   status -> anything  back on the board: hideAt = null
//   hide (admin)        hide sooner: hideAt = now
//   unhide (admin)      show for another 7 days: hideAt = now + 7d (repeatable)
export const FR_HIDE_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

// Only a RESOLVED request may carry a timer. Hiding an open one would bury work nobody has done yet
// in a table called "Completed", so both hide and unhide refuse it — a request with no timer can
// never hide, which is what keeps the board honest.
export const FR_HIDEABLE_STATUSES = ["done", "declined"] as const;

export function frIsHideable(status: string): boolean {
  return (FR_HIDEABLE_STATUSES as readonly string[]).includes(status);
}

export function frHideWindowFrom(now: Date): Date {
  return new Date(now.getTime() + FR_HIDE_WINDOW_DAYS * DAY_MS);
}

export function frIsHidden(hideAt: Date | null, now: Date): boolean {
  return hideAt !== null && hideAt.getTime() <= now.getTime();
}

// What a status change does to the timer. Returns undefined when the timer must NOT be touched, so
// the caller can spread it into a Prisma `data` without clobbering a timer that is already running.
export function frHideAtOnStatusChange(from: string, to: string, now: Date): Date | null | undefined {
  if (from === to) return undefined; // not a transition — leave the timer alone
  if (to === "done") return frHideWindowFrom(now); // implemented: retire it 7 days from now
  // Rejected is terminal too, so it keeps whatever timer it had. Clearing it here would drag an
  // already-hidden request back onto the board just because someone re-triaged it done -> declined.
  if (to === "declined") return undefined;
  return null; // back to an OPEN status (new/planned/building) — back on the board, timer cancelled
}

// The human line under a triaged request: "Hides in 3 days" / "Hidden". Null when it has no timer.
export function frHideNote(hideAt: Date | null, now: Date): string | null {
  if (hideAt === null) return null;
  if (frIsHidden(hideAt, now)) return "Hidden";
  const days = Math.ceil((hideAt.getTime() - now.getTime()) / DAY_MS);
  return days <= 1 ? "Hides in under a day" : `Hides in ${days} days`;
}

// The ticket number operators quote: 1 -> "#0000001". Wider than 7 digits once it overflows, which
// beats truncating into a collision.
export function frNumber(n: number): string {
  return `#${String(n).padStart(7, "0")}`;
}
