// Easter-egg occasion logic — pure calendar math, no I/O. Every date-driven egg (birthday banner,
// day-of holiday greetings, holiday-eve banner, holiday bulb glyph, New Year confetti) resolves
// through occasionsFor(date), so the super-admin date simulator exercises all of them. Dates are
// "YYYY-MM-DD" calendar dates; timezone resolution happens upstream in effective-date.ts. See
// docs/superpowers/specs/2026-07-24-easter-eggs-design.md for the full spec.

import { parts, ymd, toDate, addDays, lastMondayOfMay, firstMondayOfSeptember, fourthThursdayOfNovember } from "./date-math";
import { greetingsFor, type EggBanner } from "./greetings";

export type { EggBanner };
export type EggState = { banners: EggBanner[]; bulbGlyph: string; newYear: boolean; anniversary: boolean };

// The "major holidays" that get an eve banner. A constant list — extend here.
function holidaysFor(y: number): Array<{ name: string; date: Date }> {
  return [
    { name: "New Year's Day", date: toDate(y, 1, 1) },
    { name: "Memorial Day", date: lastMondayOfMay(y) },
    { name: "Independence Day", date: toDate(y, 7, 4) },
    { name: "Labor Day", date: firstMondayOfSeptember(y) },
    { name: "Thanksgiving", date: fourthThursdayOfNovember(y) },
    { name: "Christmas", date: toDate(y, 12, 25) },
  ];
}

// When does a holiday's eve banner show? The last day people are likely AT work before it:
// Tue-Fri holiday -> the day before; Sat -> Thursday (Friday assumed observed off);
// Sun -> Friday; Mon -> Friday (the literal eve is Sunday — nobody would see it).
function eveDisplayDate(holiday: Date): Date {
  switch (holiday.getDay()) {
    case 6: return addDays(holiday, -2); // Saturday -> Thursday
    case 0: return addDays(holiday, -2); // Sunday -> Friday
    case 1: return addDays(holiday, -3); // Monday -> Friday
    default: return addDays(holiday, -1); // Tue-Fri -> previous day
  }
}

function birthdayBanner(date: string, y: number): EggBanner | null {
  const bday = toDate(y, 11, 14);
  if (date === ymd(bday)) {
    return { kind: "birthday", message: "HAPPY BIRTHDAY TO MY CREATOR - EVAN KENT" };
  }
  if (bday.getDay() === 6 && date === ymd(toDate(y, 11, 13))) {
    return { kind: "birthday", message: "HAPPY BIRTHDAY TOMORROW TO MY CREATOR - EVAN KENT" };
  }
  if (bday.getDay() === 0 && date === ymd(toDate(y, 11, 15))) {
    return { kind: "birthday", message: "HAPPY BELATED BIRTHDAY TO MY CREATOR - EVAN KENT" };
  }
  return null;
}

function holidayEveBanner(date: string, y: number): EggBanner | null {
  // Check this year AND next: New Year's Day's eve lands in December of the prior year.
  for (const year of [y, y + 1]) {
    for (const h of holidaysFor(year)) {
      if (date === ymd(eveDisplayDate(h.date))) {
        return { kind: "holiday-eve", message: `I HOPE YOU HAVE TOMORROW OFF FOR ${h.name.toUpperCase()}` };
      }
    }
  }
  return null;
}

function bulbGlyph(m: number, d: number): string {
  if (m === 10 && d >= 25) return "🎃"; // Halloween week
  if (m === 12 && d >= 20 && d <= 26) return "🎄"; // Christmas week
  if ((m === 12 && d === 31) || (m === 1 && d === 1)) return "🎆"; // New Year's Eve/Day
  return "💡";
}

export function occasionsFor(date: string): EggState {
  const p = parts(date);
  if (!p) return { banners: [], bulbGlyph: "💡", newYear: false, anniversary: false };
  // All applicable occasion banners stack, in order: birthday, then day-of greetings, then eve.
  const banners: EggBanner[] = [];
  const bday = birthdayBanner(date, p.y);
  if (bday) banners.push(bday);
  banners.push(...greetingsFor(date));
  const eve = holidayEveBanner(date, p.y);
  if (eve) banners.push(eve);
  return {
    banners,
    bulbGlyph: bulbGlyph(p.m, p.d),
    newYear: p.m === 1 && p.d <= 2,
    // March 22: confetti + the wedding photo on every visit to the clients list that day
    // (anniversary-egg.tsx).
    anniversary: p.m === 3 && p.d === 22,
  };
}

// The anniversary overlay fires on arrival at a clients *list* (v1/v2/v3) — client detail
// and review pages don't count.
export function isClientsListPath(pathname: string | null | undefined): boolean {
  return pathname === "/clients" || pathname === "/clients/v2" || pathname === "/clients/v3";
}

// Milestone case sparkle: the numeric tail of a case number is a positive multiple of 1000
// (IAM0001000, UM0030000, ...).
export function isMilestoneCase(caseNumber: string | null | undefined): boolean {
  if (!caseNumber) return false;
  const m = /(\d+)$/.exec(caseNumber);
  if (!m) return false;
  const n = Number(m[1]);
  return n > 0 && n % 1000 === 0;
}
