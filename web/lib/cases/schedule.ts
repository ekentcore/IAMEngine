// Pure date math for "schedule a case to start": the default schedule suggested to the operator,
// derived from the case's effective date (offboarding date / onboarding start date). No DB access —
// unit-tested in schedule.test.ts.

export type ScheduleAction = "onboard" | "offboard";

// Local wall-clock parts of an intake date string. Intake dates arrive as "YYYY-MM-DD" (sometimes
// with a time — ServiceNow datetimes are "YYYY-MM-DD HH:mm:ss") or "MM/DD/YYYY" (subject-derived).
// Parsed manually so a date-only value becomes LOCAL midnight, not UTC (new Date("2026-07-20")
// would parse as UTC and shift the day in western timezones).
function parseEffective(raw: string): { y: number; mo: number; d: number; h: number | null; mi: number } | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?/.exec(raw.trim());
  if (iso) {
    return { y: +iso[1], mo: +iso[2], d: +iso[3], h: iso[4] !== undefined ? +iso[4] : null, mi: iso[5] !== undefined ? +iso[5] : 0 };
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (us) return { y: +us[3], mo: +us[1], d: +us[2], h: null, mi: 0 };
  return null;
}

// Step back `n` business days (Mon–Fri) from a local date; weekends don't count as steps.
export function subtractBusinessDays(date: Date, n: number): Date {
  const d = new Date(date);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

// The suggested schedule time for a case:
//   offboard → the offboarding date/time + 5 minutes (a date-only value means end of business, 17:00 local)
//   onboard  → the start date at 08:00 local, minus 3 business days (prep lead time)
// Returns null when there's no usable effective date or the suggestion is already in the past —
// the caller falls back to something near-term (e.g. now + 1h).
export function defaultScheduleFor(action: ScheduleAction, effectiveDate: string | null, now: Date): Date | null {
  if (!effectiveDate) return null;
  const p = parseEffective(effectiveDate);
  if (!p) return null;

  let at: Date;
  if (action === "offboard") {
    at = new Date(p.y, p.mo - 1, p.d, p.h ?? 17, p.h !== null ? p.mi : 0);
    at = new Date(at.getTime() + AUTO_OFFBOARD_DELAY_MS);
  } else {
    at = subtractBusinessDays(new Date(p.y, p.mo - 1, p.d, 8, 0), 3);
  }
  return at.getTime() > now.getTime() ? at : null;
}

// How long after the termination time the offboard actually fires. The single source of truth —
// defaultScheduleFor (the operator-facing suggestion) uses it too.
export const AUTO_OFFBOARD_DELAY_MS = 5 * 60_000;

// Same cap the operator-facing schedule route enforces: beyond a year out it's almost certainly a
// typo (a mis-keyed year in u_end_date — "2126-07-20"). Auto-scheduling a case a century ahead would
// flip the UI to a confident "runs <date>", so the operator stops watching a leaver who is never
// actually offboarded. Refuse to schedule and leave it held for a human.
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 3600_000;

// AUTO-SCHEDULE an offboard from the intake's termination instant (payload.offboardAt — the UTC
// instant parsed from ServiceNow's u_end_date; see intake-mapper.utcInstant). Fires 5 minutes after
// the termination time.
//
// TIMEZONES: this is deliberately pure instant math — offboardAt is an absolute moment (ISO/UTC), we
// add 5 minutes, and the sweep compares it to `new Date()`. Nothing here builds a local-time Date, so
// the server's timezone, DST, and the operator's locale cannot move the fire time. (defaultScheduleFor
// below is the OPERATOR-FACING suggestion and does use local wall-clock — that's the right call for a
// date-only value a human picked, and the wrong one for a precise instant from the source system.)
//
// Returns null when:
//   - the intake carried no time (a date-only u_end_date) — there is no instant to fire against, so
//     the case is held for a human rather than firing at a guessed hour;
//   - the termination instant is already PAST. A backdated ticket (filed after the person left) must
//     NOT auto-run a destructive offboard with nobody watching — and on first deploy, every already-
//     imported case with an old end date would otherwise go off at once. Those stay held for review.
export function autoOffboardScheduleAt(payload: Record<string, unknown>, now: Date): Date | null {
  const raw = payload.offboardAt;
  if (typeof raw !== "string" || !raw) return null;
  // STRICT instant only. Date.parse() would happily take ServiceNow's own wire format
  // ("2026-07-20 17:00:00") and — per the ECMAScript spec — read that non-ISO shape as SERVER-LOCAL
  // time, so the fire instant would silently depend on the box's timezone. utcInstant() only ever
  // emits a Z-suffixed ISO string; anything else is not something we're willing to guess about.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(raw)) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const at = new Date(ms + AUTO_OFFBOARD_DELAY_MS);
  if (at.getTime() <= now.getTime()) return null;                              // backdated — hold for a human
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) return null;       // mis-keyed year — hold for a human
  return at;
}

// Does this offboard have a target we can act on? An offboard whose intake never resolved WHO is
// leaving must never run unattended: the destructive steps would fire against a blank or ambiguous
// identity with nobody watching. (`needs_info` only gates onboards, so this is the offboard's own
// version of that check — see planning-service.)
export function offboardTargetResolved(payload: Record<string, unknown>): boolean {
  const named = (v: unknown) => typeof v === "string" && v.trim() !== "";
  return named(payload.userToOffboard) || named(payload.email) || named(payload.userPrincipalName);
}

// The case's effective date string, exactly as the cases list derives it (repository.listCases):
// onboarding → payload.startDate; offboarding → payload.dateOfOffboarding (or the legacy endDate),
// falling back to an MM/DD/YYYY in the subject on incident-sourced offboards.
export function caseEffectiveDate(action: ScheduleAction | string, payload: Record<string, unknown>, subject: string | null): string | null {
  let raw = action === "offboard" ? (payload.dateOfOffboarding ?? payload.endDate) : payload.startDate;
  if (action === "offboard" && !(typeof raw === "string" && raw)) {
    const md = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(subject ?? "");
    if (md) raw = `${md[3]}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
  }
  return typeof raw === "string" && raw ? raw : null;
}
