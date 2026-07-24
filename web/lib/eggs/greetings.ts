// Day-of holiday greetings — pure calendar logic, no I/O. Computed holidays (US majors,
// Kwanzaa, Easter via computus) work forever; lunar/lunisolar holidays come from the
// verified HOLIDAY_TABLE (2026-2032; see holiday-dates.ts). Multi-day holidays greet
// across their whole span per the spec. Solemn occasions (Memorial Day, Yom Kippur)
// carry solemn: true and render muted with no animation.
import { parts, ymd, toDate, inSpan, lastMondayOfMay, firstMondayOfSeptember, fourthThursdayOfNovember } from "./date-math";
import { HOLIDAY_TABLE } from "./holiday-dates";

export type EggBanner = {
  kind: "birthday" | "holiday-eve" | "greeting";
  message: string;
  emoji?: string;
  solemn?: boolean;
};

const COPY: Record<string, { message: string; emoji?: string; solemn?: boolean }> = {
  newYearsDay: { message: "WISHING YOU A HAPPY AND HEALTHY NEW YEAR", emoji: "🎉" },
  memorialDay: { message: "REMEMBERING THOSE WHO SERVED THIS MEMORIAL DAY", solemn: true },
  independenceDay: { message: "HAPPY INDEPENDENCE DAY", emoji: "🎆" },
  laborDay: { message: "HAPPY LABOR DAY" },
  thanksgiving: { message: "HAPPY THANKSGIVING TO YOU AND YOUR FAMILY", emoji: "🦃" },
  christmas: { message: "MERRY CHRISTMAS TO ALL", emoji: "🎄" },
  kwanzaa: { message: "JOYOUS KWANZAA" },
  easter: { message: "HAPPY EASTER", emoji: "🐣" },
  roshHashanah: { message: "SHANAH TOVAH — WISHING YOU A SWEET NEW YEAR", emoji: "🍎" },
  yomKippur: { message: "WISHING YOU AN EASY AND MEANINGFUL FAST — G'MAR CHATIMA TOVA", solemn: true },
  hanukkah: { message: "HAPPY HANUKKAH", emoji: "🕎" },
  passover: { message: "CHAG PESACH SAMEACH — HAPPY PASSOVER" },
  ramadan: { message: "RAMADAN MUBARAK", emoji: "🌙" },
  eidAlFitr: { message: "EID MUBARAK TO YOU AND YOUR FAMILY", emoji: "🌙" },
  eidAlAdha: { message: "EID MUBARAK TO YOU AND YOUR FAMILY", emoji: "🌙" },
  lunarNewYear: { message: "HAPPY LUNAR NEW YEAR", emoji: "🧧" },
  diwali: { message: "HAPPY DIWALI — FESTIVAL OF LIGHTS", emoji: "🪔" },
};

function toBanner(key: string): EggBanner {
  return { kind: "greeting", ...COPY[key] };
}

// Anonymous Gregorian computus — Easter Sunday for a Gregorian year.
export function easterFor(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toDate(y, month, day);
}

// Computed-forever holidays for year y: [key, startDate, days].
function computedFor(y: number): Array<{ key: string; start: string; days: number }> {
  return [
    { key: "newYearsDay", start: ymd(toDate(y, 1, 1)), days: 1 },
    { key: "memorialDay", start: ymd(lastMondayOfMay(y)), days: 1 },
    { key: "independenceDay", start: ymd(toDate(y, 7, 4)), days: 1 },
    { key: "laborDay", start: ymd(firstMondayOfSeptember(y)), days: 1 },
    { key: "thanksgiving", start: ymd(fourthThursdayOfNovember(y)), days: 1 },
    { key: "christmas", start: ymd(toDate(y, 12, 25)), days: 1 },
    { key: "kwanzaa", start: ymd(toDate(y, 12, 26)), days: 7 }, // through Jan 1
    { key: "easter", start: ymd(easterFor(y)), days: 1 },
  ];
}

export function greetingsFor(date: string): EggBanner[] {
  const p = parts(date);
  if (!p) return [];
  const out: EggBanner[] = [];
  // y-1 catches spans that started last December (Kwanzaa every year).
  for (const y of [p.y - 1, p.y]) {
    for (const h of computedFor(y)) {
      if (inSpan(date, h.start, h.days)) out.push(toBanner(h.key));
    }
  }
  // Table spans are matched flat, so cross-year Ramadan and double-occurrence years just work.
  for (const [key, spans] of Object.entries(HOLIDAY_TABLE)) {
    for (const s of spans) {
      if (inSpan(date, s.start, s.days)) out.push(toBanner(key));
    }
  }
  return out;
}
