// The date the easter eggs think it is. Normally today's calendar date in America/New_York (the
// app's Eastern convention — see lib/changelog/format.ts). A super_admin can override it with the
// simulated_date cookie (set by the header 📅 button) to preview date-driven eggs; the override is
// ignored for everyone else, fail-closed. NOTHING outside lib/eggs reads this — business logic,
// audit timestamps, and reports all keep using real time.

export function todayEastern(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isRealCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

export function effectiveEggDate(simCookie: string | undefined, isSuperAdmin: boolean, now: Date = new Date()): string {
  if (isSuperAdmin && simCookie && isRealCalendarDate(simCookie)) return simCookie;
  return todayEastern(now);
}
