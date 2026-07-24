// When a resolved request stops being news. What leaves the BOARD is decided by status alone (see
// frIsResolved in ./status) — an implemented request drops into the tables below the instant it is
// marked Implemented, so the board is only what is still remaining. This timer decides the second,
// quieter move: 7 days later the request folds out of the visible "Implemented and closed" table and
// into the collapsed "Archived" one, so a year of finished work doesn't grow into an endless table.
//
// "Archived" is DERIVED from hideAt (hideAt <= now), never stored as a flag and never flipped by a
// sweep — this app has no cron, and the heartbeat pulse it fakes one with only ticks while a runner is
// beating, so a quiet fleet would stall the 7-day timer. A timestamp compared at read time cannot
// stall: the request archives on its own at exactly hideAt.
//
//   status -> done       arm/re-arm the timer: hideAt = now + 7d (freshly implemented is news again)
//   status -> declined   arm it only if it has none, so re-triaging done -> declined keeps its timer
//   status -> open       back on the board: hideAt = null
//   hide (admin)         archive it sooner: hideAt = now
//   unhide (admin)       show it for another 7 days: hideAt = now + 7d (repeatable)
//
// The DB column and the two API actions are still named hideAt / hide / unhide — the timer's job
// narrowed, its mechanism did not.
import { frIsResolved } from "./status";

export const FR_HIDE_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

// Only a RESOLVED request may carry a timer. Arming one on an open request would put work nobody has
// done yet on a course for a table called "Archived", so both hide and unhide refuse it.
export const FR_HIDEABLE_STATUSES = ["done", "declined"] as const;

export function frIsHideable(status: string): boolean {
  return frIsResolved(status);
}

export function frHideWindowFrom(now: Date): Date {
  return new Date(now.getTime() + FR_HIDE_WINDOW_DAYS * DAY_MS);
}

export function frIsHidden(hideAt: Date | null, now: Date): boolean {
  return hideAt !== null && hideAt.getTime() <= now.getTime();
}

// What a status change does to the timer. Returns undefined when the timer must NOT be touched, so
// the caller can spread it into a Prisma `data` without clobbering a timer that is already running.
export function frHideAtOnStatusChange(
  from: string,
  to: string,
  now: Date,
  hideAt: Date | null = null,
): Date | null | undefined {
  if (from === to) return undefined; // not a transition — leave the timer alone
  if (to === "done") return frHideWindowFrom(now); // implemented: news for a week, then archived
  // Rejected is terminal too, and it needs a timer or it would sit in the visible table forever. Only
  // if it has none, though: re-triaging an already-archived done -> declined must not haul it back
  // into the visible table just because someone corrected the outcome.
  if (to === "declined") return hideAt === null ? frHideWindowFrom(now) : undefined;
  return null; // back to an OPEN status (new/planned/building) — back on the board, timer cancelled
}

// The human line on a resolved request: "Archives in 3 days" / "Archived". Null when it has no timer.
export function frHideNote(hideAt: Date | null, now: Date): string | null {
  if (hideAt === null) return null;
  if (frIsHidden(hideAt, now)) return "Archived";
  const days = Math.ceil((hideAt.getTime() - now.getTime()) / DAY_MS);
  return days <= 1 ? "Archives in under a day" : `Archives in ${days} days`;
}

// The ticket number operators quote: 1 -> "#0000001". Wider than 7 digits once it overflows, which
// beats truncating into a collision.
export function frNumber(n: number): string {
  return `#${String(n).padStart(7, "0")}`;
}
