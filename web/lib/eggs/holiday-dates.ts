// Verified holiday dates, 2026-2032. COMPILED FROM AUTHORITATIVE SOURCES on 2026-07-24 —
// see the per-holiday source URLs below (from .superpowers/sdd/holiday-dates.json).
// Jewish holidays use the first-full-day civil-date convention (the holiday begins the
// previous sundown). Islamic dates are PROJECTED; actual observance can shift ±1 day.
// MAINTENANCE: this table runs out after 2032 — greetings for these holidays quietly
// stop rendering then. To extend: re-verify dates from the sources below and append
// spans; lib/eggs/greetings.test.ts anchors will still pass (they pin existing rows).
//
// Sources (from .superpowers/sdd/holiday-dates.json "sources"):
//   roshHashanah:
//     - https://www.hebcal.com/hebcal?v=1&cfg=json&year=2026&maj=on&min=on (Hebcal Diaspora JSON API, fetched per-year 2026-2032)
//     - https://www.hebcal.com/holidays/rosh-hashana-2026
//   yomKippur:
//     - https://www.hebcal.com/hebcal?v=1&cfg=json&year=2026&maj=on&min=on (Hebcal Diaspora JSON API, fetched per-year 2026-2032)
//     - https://en.wikipedia.org/wiki/Yom_Kippur
//   hanukkah:
//     - https://www.hebcal.com/hebcal?v=1&cfg=json&year=2026&maj=on&min=on (Hebcal Diaspora JSON API, fetched per-year 2026-2032)
//     - https://www.hebcal.com/holidays/2026
//   passover:
//     - https://www.hebcal.com/hebcal?v=1&cfg=json&year=2026&maj=on&min=on (Hebcal Diaspora JSON API, fetched per-year 2026-2032)
//     - https://www.hebcal.com/holidays/2026
//   ramadan:
//     - https://api.aladhan.com/v1/hToG/{DD-MM-YYYY} (Aladhan Umm al-Qura tabular Hijri-Gregorian conversion, queried for 1 Ramadan / 1 Shawwal / 10 Dhul Hijjah, AH 1447-1454)
//     - https://www.qppstudio.net/global-holidays-observances/start-of-ramadan.htm
//   eidAlFitr:
//     - https://api.aladhan.com/v1/hToG/{DD-MM-YYYY} (Aladhan Umm al-Qura tabular calendar, 1 Shawwal AH 1447-1453)
//     - https://www.qppstudio.net/global-holidays-observances/eid-al-fitr-end-of-ramadan.htm
//   eidAlAdha:
//     - https://api.aladhan.com/v1/hToG/{DD-MM-YYYY} (Aladhan Umm al-Qura tabular calendar, 10 Dhul Hijjah AH 1447-1453)
//     - https://www.qppstudio.net/global-holidays-observances/eid-al-adha-feast-of-sacrifice.htm
//   lunarNewYear:
//     - https://www.qppstudio.net/global-holidays-observances/chinese-new-year-spring-festival.htm
//     - https://www.chinesefortunecalendar.com/TDB/NewYearDays.asp
//   diwali:
//     - https://www.qppstudio.net/global-holidays-observances/northern-deepavali-diwali-amavasya.htm
//     - https://www.drikpanchang.com/diwali/diwali-puja-calendar.html (per-year Diwali/Lakshmi Puja calendar, New Delhi)
//
// Caveats (from .superpowers/sdd/holiday-dates.json "caveats"):
//   - Islamic dates (Ramadan, Eid al-Fitr, Eid al-Adha) are computed from the Umm al-Qura
//     tabular Islamic calendar (used administratively in Saudi Arabia/Gulf and by most
//     published "projected" calendars). Actual observance depends on physical moon sighting
//     and can shift by 1 day, occasionally 2 days, from these projected dates and can vary
//     by country.
//   - Hijri/Gregorian year-alignment for Ramadan: because the ~354-day Hijri year drifts
//     against the 365-day Gregorian year, a Ramadan cycle occasionally starts in one civil
//     year while its Eid al-Fitr falls in the next, and some civil years contain two Ramadan
//     starts while others contain none by a "start-date" labeling convention. To keep each
//     civil-year row internally consistent (Ramadan + its own Eid al-Fitr + its own Eid
//     al-Adha all from the same Hijri year), each year here is labeled by the Hijri year
//     whose Eid al-Fitr (1 Shawwal) falls within that civil year. Practical effect: civil
//     year 2030 is a "double Ramadan" year in the Umm al-Qura calendar (Jan 5-Feb 3, 2030,
//     and a second cycle starting Dec 26, 2030); we assign the Jan 5 cycle to the "2030" row.
//     The "2031" row's Ramadan therefore STARTS on Dec 26, 2030 (its Eid al-Fitr, Jan 24,
//     2031, is what lands in civil 2031), and the "2032" row's Ramadan starts Dec 15, 2031
//     (Eid al-Fitr Jan 14, 2032 lands in civil 2032). Other widely-published tables (e.g.
//     qppstudio's own "Start of Ramadan" list) instead label strictly by start-year, which
//     would give Dec 15, 2031 for "2031" and Dec 4, 2032 for "2032" -- a full Ramadan-cycle
//     offset from this file's 2031/2032 rows. Re-verify against your target locale's
//     convention before display if this edge case matters for the feature.
//   - Hanukkah convention: Hebcal's "Chanukah: 1 Candle" date is the evening the first
//     candle is lit, which marks the START of the first Hebrew day (analogous to "Erev" for
//     other holidays). This file's Hanukkah "start" is the first FULL civil day, i.e. one
//     day after Hebcal's "1 Candle" date. The "end" (last full day) is Hebcal's own
//     "Chanukah: 8th Day" (Zot Hanukkah) date, one day after "8 Candles". Span start-to-end
//     inclusive is 8 days in every year checked.
//   - Rosh Hashanah / Yom Kippur / Passover "start" dates are the first FULL (daytime)
//     civil date of the holiday. Per Hebcal's own convention, the holiday actually begins
//     at sundown the evening before (Hebcal's "Erev" label), one calendar day earlier than
//     the "start" date given here.
//   - Rosh Hashanah spans 2 days (first full day + second day) in both Diaspora and Israel
//     usage. Passover here uses the Diaspora convention (8 days, first/last full days as
//     "Yom Tov"; Israel observes 7 days with different intermediate-day labeling, ending
//     one day earlier).
//   - Diwali: "main day" = Lakshmi Puja / Amavasya day per the Northern Indian convention
//     (qppstudio and Drikpanchang agree exactly on all 7 dates checked). Some regions
//     (notably South India) observe their principal celebration (Naraka Chaturdashi) one
//     day earlier; that regional variant is not included here.
//   - Chinese/Lunar New Year: only New Year's Day itself is dated; "days: 15" is a note
//     that the traditional festival period runs 15 days through the Lantern Festival, not
//     15 explicit dates.
//   - All Jewish holiday dates are Hebcal's DIASPORA calendar (not the Israel calendar),
//     fetched directly from Hebcal's public JSON API for each year 2026-2032 individually
//     and spot-checked against hebcal.com holiday pages and other independent summaries --
//     no disagreements found between sources for these four holiday categories.
//   - Islamic and Jewish sources independently agreed with each other and with a second
//     source in every case checked; the only genuine source disagreement encountered was
//     the Ramadan 2030/2031 boundary double-cycle described above, which is a real
//     calendrical ambiguity rather than a data error.

export type HolidaySpan = { start: string; days: number };

export const HOLIDAY_TABLE: Record<string, HolidaySpan[]> = {
  roshHashanah: [
    { start: "2026-09-12", days: 2 },
    { start: "2027-10-02", days: 2 },
    { start: "2028-09-21", days: 2 },
    { start: "2029-09-10", days: 2 },
    { start: "2030-09-28", days: 2 },
    { start: "2031-09-18", days: 2 },
    { start: "2032-09-06", days: 2 },
  ],
  yomKippur: [
    { start: "2026-09-21", days: 1 },
    { start: "2027-10-11", days: 1 },
    { start: "2028-09-30", days: 1 },
    { start: "2029-09-19", days: 1 },
    { start: "2030-10-07", days: 1 },
    { start: "2031-09-27", days: 1 },
    { start: "2032-09-15", days: 1 },
  ],
  hanukkah: [
    { start: "2026-12-05", days: 8 },
    { start: "2027-12-25", days: 8 },
    { start: "2028-12-13", days: 8 },
    { start: "2029-12-02", days: 8 },
    { start: "2030-12-21", days: 8 },
    { start: "2031-12-10", days: 8 },
    { start: "2032-11-28", days: 8 },
  ],
  passover: [
    { start: "2026-04-02", days: 8 },
    { start: "2027-04-22", days: 8 },
    { start: "2028-04-11", days: 8 },
    { start: "2029-03-31", days: 8 },
    { start: "2030-04-18", days: 8 },
    { start: "2031-04-08", days: 8 },
    { start: "2032-03-27", days: 8 },
  ],
  // days computed from start..end inclusive (see JSON "end" values in the Ramadan
  // year-labeling caveat above).
  ramadan: [
    { start: "2026-02-18", days: 30 }, // end 2026-03-19
    { start: "2027-02-08", days: 29 }, // end 2027-03-08
    { start: "2028-01-28", days: 29 }, // end 2028-02-25
    { start: "2029-01-16", days: 29 }, // end 2029-02-13
    { start: "2030-01-05", days: 30 }, // end 2030-02-03
    { start: "2030-12-26", days: 29 }, // 2031 row; end 2031-01-23 (see double-Ramadan caveat)
    { start: "2031-12-15", days: 30 }, // 2032 row; end 2032-01-13 (see double-Ramadan caveat)
  ],
  eidAlFitr: [
    { start: "2026-03-20", days: 1 },
    { start: "2027-03-09", days: 1 },
    { start: "2028-02-26", days: 1 },
    { start: "2029-02-14", days: 1 },
    { start: "2030-02-04", days: 1 },
    { start: "2031-01-24", days: 1 },
    { start: "2032-01-14", days: 1 },
  ],
  eidAlAdha: [
    { start: "2026-05-27", days: 1 },
    { start: "2027-05-16", days: 1 },
    { start: "2028-05-05", days: 1 },
    { start: "2029-04-24", days: 1 },
    { start: "2030-04-13", days: 1 },
    { start: "2031-04-02", days: 1 },
    { start: "2032-03-22", days: 1 },
  ],
  lunarNewYear: [
    { start: "2026-02-17", days: 15 },
    { start: "2027-02-06", days: 15 },
    { start: "2028-01-26", days: 15 },
    { start: "2029-02-13", days: 15 },
    { start: "2030-02-03", days: 15 },
    { start: "2031-01-23", days: 15 },
    { start: "2032-02-11", days: 15 },
  ],
  diwali: [
    { start: "2026-11-08", days: 1 },
    { start: "2027-10-29", days: 1 },
    { start: "2028-10-17", days: 1 },
    { start: "2029-11-05", days: 1 },
    { start: "2030-10-26", days: 1 },
    { start: "2031-11-14", days: 1 },
    { start: "2032-11-02", days: 1 },
  ],
};
