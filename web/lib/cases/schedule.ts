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
    at = new Date(at.getTime() + 5 * 60_000);
  } else {
    at = subtractBusinessDays(new Date(p.y, p.mo - 1, p.d, 8, 0), 3);
  }
  return at.getTime() > now.getTime() ? at : null;
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
