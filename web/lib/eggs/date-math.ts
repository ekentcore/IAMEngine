// Shared calendar math for the easter-egg modules. Pure; dates are "YYYY-MM-DD" strings
// or local-time Date objects used only for calendar arithmetic, never for "now".

export function parts(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function toDate(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

export function addDays(date: Date, delta: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + delta);
  return out;
}

// Is `date` within the `days`-long window starting at `start` (both inclusive)?
// ISO date strings compare correctly as strings.
export function inSpan(date: string, start: string, days: number): boolean {
  const p = parts(start);
  if (!p || days < 1) return false;
  const end = ymd(addDays(toDate(p.y, p.m, p.d), days - 1));
  return date >= start && date <= end;
}

export function lastMondayOfMay(y: number): Date {
  const d = toDate(y, 5, 31);
  while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  return d;
}

export function firstMondayOfSeptember(y: number): Date {
  const d = toDate(y, 9, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d;
}

export function fourthThursdayOfNovember(y: number): Date {
  const d = toDate(y, 11, 1);
  while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
  return addDays(d, 21);
}
