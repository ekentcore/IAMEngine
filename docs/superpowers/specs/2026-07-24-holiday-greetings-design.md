# Holiday day-of greetings — design spec (addendum to easter eggs)

**Date:** 2026-07-24
**Author:** Evan Kent (with Claude)
**Status:** Approved by Evan 2026-07-24
**Extends:** `2026-07-24-easter-eggs-design.md` (shipped in PR #3)

On the actual holiday, the banner wishes people an appropriate greeting — covering US,
Jewish, Muslim, Chinese, and other significant cultural/religious holidays. Multi-day
holidays show the greeting for their whole span (per Evan). Everything remains cosmetic
and flows through the same `lib/eggs` seam, so the 📅 simulator previews all of it.

## Hard requirement (Evan, verbatim intent)

The date simulation must never cause real work — it exists only to preview banners and
other date-driven cosmetics. No case planning, offboarding, job dispatch, or any business
logic may ever read the simulated date. This was already true (single read site feeding
only `lib/eggs`); this addendum adds a **conformance test** that fails the suite if the
string `simulated_date` ever appears outside an explicit allowlist (layout read site,
date-simulator component, `lib/eggs/`, and their tests).

## New banner kind: `greeting`

`EggBanner` gains `kind: "greeting"` plus `emoji?: string` and `solemn?: boolean`.
`EggState.banner: EggBanner | null` becomes **`banners: EggBanner[]`** — on overlap days
the strips stack, ordered: birthday → greetings → holiday-eve. (Real overlaps exist:
Hanukkah regularly spans Christmas; Kwanzaa overlaps New Year's Day.)

Solemn greetings (Yom Kippur, Memorial Day) render muted — neutral palette, **no**
falling-emoji animation. Festive greetings use a new greeting palette (indigo pastel)
with the existing `.egg-fall` animation when an emoji is present.

## Computed holidays (forever, no table)

| Holiday | Day(s) | Greeting (exact copy, uppercase) | Emoji |
|---|---|---|---|
| New Year's Day | Jan 1 | WISHING YOU A HAPPY AND HEALTHY NEW YEAR | 🎉 |
| Memorial Day | last Mon May | REMEMBERING THOSE WHO SERVED THIS MEMORIAL DAY | — (solemn) |
| Independence Day | Jul 4 | HAPPY INDEPENDENCE DAY | 🎆 |
| Labor Day | first Mon Sep | HAPPY LABOR DAY | — |
| Thanksgiving | 4th Thu Nov | HAPPY THANKSGIVING TO YOU AND YOUR FAMILY | 🦃 |
| Christmas | Dec 25 | MERRY CHRISTMAS TO ALL | 🎄 |
| Kwanzaa | Dec 26–Jan 1 (7 days, crosses year) | JOYOUS KWANZAA | — |
| Easter | computus (Anonymous Gregorian algorithm) | HAPPY EASTER | 🐣 |

The first three greetings are Evan's copy verbatim. Memorial Day deliberately avoids
"Happy" — it is a solemn remembrance.

## Table-driven holidays (verified dates, 2026–2032)

| Holiday | Span | Greeting | Emoji |
|---|---|---|---|
| Rosh Hashanah | 2 days | SHANAH TOVAH — WISHING YOU A SWEET NEW YEAR | 🍎 |
| Yom Kippur | 1 day | WISHING YOU AN EASY AND MEANINGFUL FAST — G'MAR CHATIMA TOVA | — (solemn) |
| Hanukkah | 8 days | HAPPY HANUKKAH | 🕎 |
| Passover | 8 days | CHAG PESACH SAMEACH — HAPPY PASSOVER | — |
| Ramadan | whole month | RAMADAN MUBARAK | 🌙 |
| Eid al-Fitr | 1 day | EID MUBARAK TO YOU AND YOUR FAMILY | 🌙 |
| Eid al-Adha | 1 day | EID MUBARAK TO YOU AND YOUR FAMILY | 🌙 |
| Lunar New Year | 15 days (through Lantern Festival) | HAPPY LUNAR NEW YEAR | 🧧 |
| Diwali | main day | HAPPY DIWALI — FESTIVAL OF LIGHTS | 🪔 |

Data rules:
- Dates live in `web/lib/eggs/holiday-dates.ts`, compiled by a research pass from
  authoritative sources (Hebcal for Jewish holidays; published projected civil dates for
  Islamic ones; official/astronomical dates for Lunar New Year; most-cited main day for
  Diwali). Every holiday's source URLs and caveats are recorded in the file's comments,
  plus a MAINTENANCE note explaining how to extend the table before 2033.
- Jewish holidays use the **first-full-day civil-date convention** (the holiday begins
  the previous sundown; the banner shows on the civil day(s)).
- Islamic dates are projections — actual observance can shift ±1 day; noted in-file.
- Entries are matched as a **flat list of date spans**, not keyed lookups by year, so
  spans that cross a Gregorian year boundary (Kwanzaa every year; Ramadan around
  2030–2031) and years containing two Ramadans work naturally.
- Past the table horizon the greeting quietly doesn't render — never a crash, never a
  guess.

## Structure

- `web/lib/eggs/holiday-dates.ts` — data only (typed spans + sources/caveats comments).
- `web/lib/eggs/greetings.ts` — pure `greetingsFor(date: string): EggBanner[]`
  (computed holidays incl. Easter computus + table span matching). Fully unit-tested.
- `web/lib/eggs/occasions.ts` — composes `banners = [birthday?, ...greetings, eve?]`.
- `web/app/_components/eggs/occasion-banner.tsx` — greeting + solemn styles.
- `web/app/layout.tsx` — maps over `eggs.banners`.
- `web/lib/eggs/simulated-date-isolation.test.ts` — the conformance test (see hard
  requirement above).

## Testing

- Anchor tests per holiday from the verified table (at least 2026 + one later year each).
- Easter computus against independently verified dates (2026–2028).
- Cross-year spans: Kwanzaa on Jan 1; the Ramadan year-boundary occurrence near
  2030–2031 from the table.
- Whole-span coverage: mid-Hanukkah and mid-Ramadan dates greet; day-after does not.
- Stacking: a date inside Hanukkah that is also Dec 25 yields both greetings; birthday
  still wins first position; solemn flags set for Yom Kippur and Memorial Day.
- Conformance: `simulated_date` string confined to the allowlist.
- Existing eve-banner and birthday tests updated for the `banners[]` shape, behavior
  unchanged.

## Out of scope

- No eve ("tomorrow off") banners for the new holidays — greetings only.
- No DB, schema, middleware, runner, or dependency changes.
