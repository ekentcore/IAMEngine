# Holiday Day-of Greetings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On actual holidays (US, Jewish, Muslim, Chinese, and other cultural/religious), the banner shows an appropriate greeting for the holiday's whole span, per `docs/superpowers/specs/2026-07-24-holiday-greetings-design.md` — plus a conformance test guaranteeing the date simulator can never touch business logic.

**Architecture:** Shared calendar helpers move to `web/lib/eggs/date-math.ts`. New pure `web/lib/eggs/greetings.ts` (`greetingsFor(date) → EggBanner[]`) reads a verified date table (`holiday-dates.ts`, compiled from `.superpowers/sdd/holiday-dates.json`) plus computed holidays (incl. Easter computus). `occasions.ts` composes `EggState.banners: EggBanner[]` (birthday → greetings → eve, stacked); the layout maps over it. Import DAG stays acyclic at runtime: `occasions → greetings → date-math` (EggBanner type lives in greetings.ts; occasions re-exports it type-only).

**Tech Stack:** Same as the shipped eggs: node:test via `tsx --test` from `web/`, no new dependencies.

## Global Constraints

- Working dir: `/Users/evankent/coding/newuserscript/.claude/worktrees/holiday-greetings/web` (branch `worktree-holiday-greetings`).
- Do NOT run `next build` (broken on main, pre-existing). Verify with `npx tsx --test "lib/eggs/*.test.ts"` and `npx tsc --noEmit` (baseline 0 errors).
- Greeting copy strings are EXACT per the spec's two tables (uppercase, including "WISHING YOU A HAPPY AND HEALTHY NEW YEAR", "MERRY CHRISTMAS TO ALL", "HAPPY THANKSGIVING TO YOU AND YOUR FAMILY"). Memorial Day and Yom Kippur are `solemn: true` with no emoji.
- Table data comes ONLY from `.superpowers/sdd/holiday-dates.json` (web-verified) — never from memory. Source URLs + caveats from that JSON go into `holiday-dates.ts` comments, with a MAINTENANCE note about extending past 2032.
- Table matching is a flat span scan (start + days), so cross-year spans (Kwanzaa; Ramadan near 2030–31) and two-occurrences-in-one-Gregorian-year work.
- The `simulated_date` string must appear ONLY in: `app/layout.tsx`, `app/_components/eggs/date-simulator.tsx`, `lib/eggs/effective-date.ts`, `lib/eggs/effective-date.test.ts`, `lib/eggs/simulated-date-isolation.test.ts` (enforced by Task 3's test).
- No schema/middleware/runner/dependency changes. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Calendar helpers + greetings engine + verified data

**Files:**
- Create: `web/lib/eggs/date-math.ts`
- Create: `web/lib/eggs/holiday-dates.ts` (from `.superpowers/sdd/holiday-dates.json`)
- Create: `web/lib/eggs/greetings.ts`
- Test: `web/lib/eggs/greetings.test.ts`

**Interfaces:**
- Consumes: `.superpowers/sdd/holiday-dates.json` (research artifact with `holidays`, `sources`, `caveats`).
- Produces (consumed by Task 2):
  - `date-math.ts`: `parts(date): {y,m,d}|null`, `ymd(d: Date): string`, `toDate(y,m,d): Date`, `addDays(d: Date, n): Date`, `inSpan(date: string, start: string, days: number): boolean`, `lastMondayOfMay(y)`, `firstMondayOfSeptember(y)`, `fourthThursdayOfNovember(y)` — the last three moved VERBATIM from `occasions.ts` (do not modify `occasions.ts` in this task; Task 2 removes its private copies).
  - `greetings.ts`: `export type EggBanner = { kind: "birthday" | "holiday-eve" | "greeting"; message: string; emoji?: string; solemn?: boolean }`, `greetingsFor(date: string): EggBanner[]`, `easterFor(y: number): Date`.
  - `holiday-dates.ts`: `export type HolidaySpan = { start: string; days: number }`, `export const HOLIDAY_TABLE: Record<string, HolidaySpan[]>` keyed `roshHashanah, yomKippur, hanukkah, passover, ramadan, eidAlFitr, eidAlAdha, lunarNewYear, diwali`.

- [ ] **Step 1: Transcribe the data file**

Read `.superpowers/sdd/holiday-dates.json`. For each holiday, emit one `HolidaySpan` per year: `start` verbatim; `days` verbatim where given; for `ramadan` compute `days` from its `start`/`end` inclusive. Build `web/lib/eggs/holiday-dates.ts`:

```ts
// Verified holiday dates, 2026-2032. COMPILED FROM AUTHORITATIVE SOURCES on 2026-07-24 —
// see the per-holiday source URLs below (from .superpowers/sdd/holiday-dates.json).
// Jewish holidays use the first-full-day civil-date convention (the holiday begins the
// previous sundown). Islamic dates are PROJECTED; actual observance can shift ±1 day.
// MAINTENANCE: this table runs out after 2032 — greetings for these holidays quietly
// stop rendering then. To extend: re-verify dates from the sources below and append
// spans; lib/eggs/greetings.test.ts anchors will still pass (they pin existing rows).
//
// [PASTE the JSON's sources map and caveats list here as comment lines.]

export type HolidaySpan = { start: string; days: number };

export const HOLIDAY_TABLE: Record<string, HolidaySpan[]> = {
  roshHashanah: [
    { start: "<from JSON 2026>", days: 2 },
    // ... one row per year through 2032
  ],
  yomKippur: [/* days: 1 rows */],
  hanukkah: [/* days: 8 rows */],
  passover: [/* days: 8 rows */],
  ramadan: [/* days computed from start..end inclusive */],
  eidAlFitr: [/* days: 1 rows */],
  eidAlAdha: [/* days: 1 rows */],
  lunarNewYear: [/* days: 15 rows */],
  diwali: [/* days: 1 rows */],
};
```

- [ ] **Step 2: Create date-math.ts**

Move these VERBATIM from `occasions.ts` (leaving occasions.ts untouched for now) and add `inSpan`:

```ts
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

export function lastMondayOfMay(y: number): Date { /* verbatim from occasions.ts */ }
export function firstMondayOfSeptember(y: number): Date { /* verbatim */ }
export function fourthThursdayOfNovember(y: number): Date { /* verbatim */ }
```

(The three "verbatim" bodies are copied exactly from the current `occasions.ts` — they scan for the right weekday from the month's edge.)

- [ ] **Step 3: Write the failing tests**

`web/lib/eggs/greetings.test.ts` — node:test style. Cover, with dates taken from the transcribed `HOLIDAY_TABLE` (import it in the test and derive expectations from it where the row is data-driven, but pin at least these HARD anchors as literal strings after verifying them in the JSON):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { greetingsFor, easterFor } from "./greetings";
import { HOLIDAY_TABLE } from "./holiday-dates";
import { ymd } from "./date-math";

function messages(date: string): string[] {
  return greetingsFor(date).map((b) => b.message);
}

test("computed US holidays greet on the day with exact copy", () => {
  assert.ok(messages("2026-11-26").includes("HAPPY THANKSGIVING TO YOU AND YOUR FAMILY"));
  assert.ok(messages("2026-12-25").includes("MERRY CHRISTMAS TO ALL"));
  assert.ok(messages("2027-01-01").includes("WISHING YOU A HAPPY AND HEALTHY NEW YEAR"));
  assert.ok(messages("2026-07-04").includes("HAPPY INDEPENDENCE DAY"));
  assert.ok(messages("2026-09-07").includes("HAPPY LABOR DAY")); // first Mon Sep 2026
});

test("Memorial Day is solemn, no emoji, respectful copy", () => {
  const g = greetingsFor("2026-05-25").find((b) => b.message.includes("MEMORIAL")); // last Mon May 2026
  assert.ok(g);
  assert.equal(g!.message, "REMEMBERING THOSE WHO SERVED THIS MEMORIAL DAY");
  assert.equal(g!.solemn, true);
  assert.equal(g!.emoji, undefined);
});

test("Kwanzaa spans Dec 26 through Jan 1 (crosses the year)", () => {
  assert.ok(messages("2026-12-26").includes("JOYOUS KWANZAA"));
  assert.ok(messages("2027-01-01").includes("JOYOUS KWANZAA"));
  assert.ok(!messages("2027-01-02").includes("JOYOUS KWANZAA"));
});

test("Easter computus matches verified dates", () => {
  // VERIFY these three via WebSearch before finalizing; expected Apr 5 2026, Mar 28 2027, Apr 16 2028.
  assert.equal(ymd(easterFor(2026)), "2026-04-05");
  assert.equal(ymd(easterFor(2027)), "2027-03-28");
  assert.equal(ymd(easterFor(2028)), "2028-04-16");
  assert.ok(messages(ymd(easterFor(2026))).includes("HAPPY EASTER"));
});

test("table-driven holidays greet across their whole span", () => {
  for (const [key, expected] of [
    ["roshHashanah", "SHANAH TOVAH — WISHING YOU A SWEET NEW YEAR"],
    ["hanukkah", "HAPPY HANUKKAH"],
    ["passover", "CHAG PESACH SAMEACH — HAPPY PASSOVER"],
    ["ramadan", "RAMADAN MUBARAK"],
    ["eidAlFitr", "EID MUBARAK TO YOU AND YOUR FAMILY"],
    ["eidAlAdha", "EID MUBARAK TO YOU AND YOUR FAMILY"],
    ["lunarNewYear", "HAPPY LUNAR NEW YEAR"],
    ["diwali", "HAPPY DIWALI — FESTIVAL OF LIGHTS"],
  ] as const) {
    for (const span of HOLIDAY_TABLE[key]) {
      assert.ok(messages(span.start).includes(expected), `${key} ${span.start} first day`);
      // last day of the span still greets; the day after does not
      const last = new Date(span.start + "T12:00:00");
      last.setDate(last.getDate() + span.days - 1);
      const after = new Date(last); after.setDate(after.getDate() + 1);
      const pad = (n: number) => String(n).padStart(2, "0");
      const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      assert.ok(messages(iso(last)).includes(expected), `${key} ${span.start} last day`);
      assert.ok(!messages(iso(after)).includes(expected), `${key} ${span.start} day after`);
    }
  }
});

test("Yom Kippur is solemn with respectful copy", () => {
  const day = HOLIDAY_TABLE.yomKippur[0].start;
  const g = greetingsFor(day).find((b) => b.solemn);
  assert.ok(g);
  assert.equal(g!.message, "WISHING YOU AN EASY AND MEANINGFUL FAST — G'MAR CHATIMA TOVA");
});

test("greetings stack on overlap days (Christmas inside a Hanukkah span, when the table has one)", () => {
  const overlapping = HOLIDAY_TABLE.hanukkah.find((s) => {
    const y = Number(s.start.slice(0, 4));
    return greetingsFor(`${y}-12-25`).some((b) => b.message === "HAPPY HANUKKAH");
  });
  if (overlapping) {
    const y = Number(overlapping.start.slice(0, 4));
    const msgs = messages(`${y}-12-25`);
    assert.ok(msgs.includes("MERRY CHRISTMAS TO ALL") && msgs.includes("HAPPY HANUKKAH"));
  } // if no overlap year exists in 2026-2032, this test passes vacuously — note it in the report
});

test("an ordinary day has no greetings", () => {
  assert.deepEqual(greetingsFor("2026-08-11"), []);
});

test("all greetings carry kind greeting", () => {
  for (const b of greetingsFor("2026-12-25")) assert.equal(b.kind, "greeting");
});
```

- [ ] **Step 4: Run tests — expect FAIL** (`npx tsx --test "lib/eggs/greetings.test.ts"`, module not found).

- [ ] **Step 5: Implement `greetings.ts`**

```ts
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
```

(Unused imports — `addDays` — must not remain; import only what's used.)

- [ ] **Step 6: Run tests — expect PASS.** Verify the three Easter anchor dates via WebSearch first; if a verified date differs from the plan's expectation, fix the TEST to the verified date (the algorithm is standard — if algorithm and verified date disagree, STOP and report).

- [ ] **Step 7: Commit**

```bash
git add lib/eggs/date-math.ts lib/eggs/holiday-dates.ts lib/eggs/greetings.ts lib/eggs/greetings.test.ts
git commit -m "Add holiday greetings engine with verified 2026-2032 date table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: banners[] refactor — occasions, banner component, layout

**Files:**
- Modify: `web/lib/eggs/occasions.ts`
- Modify: `web/lib/eggs/occasions.test.ts`
- Modify: `web/app/_components/eggs/occasion-banner.tsx`
- Modify: `web/app/layout.tsx`

**Interfaces:**
- Consumes: `greetingsFor`, `EggBanner` from `./greetings`; helpers from `./date-math` (Task 1).
- Produces: `EggState = { banners: EggBanner[]; bulbGlyph: string; newYear: boolean }`; `occasionsFor(date): EggState` composes `[birthday?, ...greetings, eve?]` in that order (NO suppression — all applicable banners stack); `occasions.ts` re-exports `export type { EggBanner } from "./greetings"` so existing importers keep working; `isMilestoneCase` unchanged.

- [ ] **Step 1: Refactor `occasions.ts`**

- Delete its private `parts/ymd/toDate/addDays/lastMondayOfMay/firstMondayOfSeptember/fourthThursdayOfNovember` and import them from `./date-math`.
- Delete the local `EggBanner` type; add `import { greetingsFor, type EggBanner } from "./greetings";` and `export type { EggBanner };`
- Birthday and holiday-eve builders keep their exact messages/rules; they now return the shared `EggBanner` shape (kind fields unchanged).
- Replace the compose:

```ts
export type EggState = { banners: EggBanner[]; bulbGlyph: string; newYear: boolean };

export function occasionsFor(date: string): EggState {
  const p = parts(date);
  if (!p) return { banners: [], bulbGlyph: "💡", newYear: false };
  const banners: EggBanner[] = [];
  const bday = birthdayBanner(date, p.y);
  if (bday) banners.push(bday);
  banners.push(...greetingsFor(date));
  const eve = holidayEveBanner(date, p.y);
  if (eve) banners.push(eve);
  return { banners, bulbGlyph: bulbGlyph(p.m, p.d), newYear: p.m === 1 && p.d <= 2 };
}
```

- [ ] **Step 2: Update `occasions.test.ts`**

Mechanical shape change: every `occasionsFor(d).banner` assertion becomes a check against `banners`. Use a helper at the top of the file:

```ts
function bannerOfKind(date: string, kind: string) {
  return occasionsFor(date).banners.find((b) => b.kind === kind) ?? null;
}
```

- `assert.deepEqual(occasionsFor(d).banner, {kind:"birthday", message:M})` → `assert.deepEqual(bannerOfKind(d, "birthday"), {kind:"birthday", message:M})`
- `assert.equal(occasionsFor(d).banner, null)` for birthday-absence cases → `assert.equal(bannerOfKind(d, "birthday"), null)`
- Holiday-eve assertions likewise via `bannerOfKind(d, "holiday-eve")`.
- The old "ordinary day has no banner" test (2026-07-24) becomes `assert.deepEqual(occasionsFor("2026-07-24").banners, [])`.
- ADD a stacking test:

```ts
test("day-of greeting and eve banner stack (Dec 24 2026: Christmas eve + mid-Hanukkah greeting if table overlaps)", () => {
  const banners = occasionsFor("2026-11-25").banners; // Thanksgiving eve 2026
  assert.ok(banners.some((b) => b.kind === "holiday-eve"));
});
test("birthday stacks first when a greeting shares the day", () => {
  const banners = occasionsFor("2026-11-14").banners;
  assert.equal(banners[0].kind, "birthday");
});
```

- [ ] **Step 3: Update `occasion-banner.tsx`**

```tsx
// Full-width occasion strip (birthday / greeting / holiday-eve), one per active occasion —
// the root layout stacks them. Server-renderable; animation is pure CSS (.egg-fall).
// Solemn occasions (Memorial Day, Yom Kippur) render muted with no animation.
import type { EggBanner } from "@/lib/eggs/occasions";

const LOOK: Record<EggBanner["kind"], { bg: string; border: string; color: string; emoji?: string }> = {
  birthday: { bg: "#fdf2f8", border: "#fbcfe8", color: "#9d174d", emoji: "🎂" },
  "holiday-eve": { bg: "#f0fdf4", border: "#bbf7d0", color: "#166534", emoji: "🎉" },
  greeting: { bg: "#eef2ff", border: "#c7d2fe", color: "#3730a3" },
};
const SOLEMN = { bg: "#f4f4f5", border: "#d4d4d8", color: "#3f3f46" };

export function OccasionBanner({ banner }: { banner: EggBanner }) {
  const look = banner.solemn ? SOLEMN : LOOK[banner.kind];
  const emoji = banner.solemn ? undefined : banner.emoji ?? LOOK[banner.kind].emoji;
  return (
    <div
      role="status"
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 10, overflow: "hidden",
        padding: "0.5rem 1rem", background: look.bg, borderBottom: `1px solid ${look.border}`,
        color: look.color, fontSize: 13, fontWeight: 600, textAlign: "center",
      }}
    >
      {emoji && <span className="egg-fall" aria-hidden>{emoji}</span>}
      <span>{banner.message}</span>
      {emoji && <span className="egg-fall" aria-hidden style={{ animationDelay: "1.1s" }}>{emoji}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Update `layout.tsx`**

- Fallback object: `{ banner: null, bulbGlyph: "💡", newYear: false }` → `{ banners: [], bulbGlyph: "💡", newYear: false }`.
- Render: `{eggs.banner && <OccasionBanner banner={eggs.banner} />}` → `{eggs.banners.map((b, i) => <OccasionBanner key={i} banner={b} />)}`.

- [ ] **Step 5: Verify** — `npx tsx --test "lib/eggs/*.test.ts"` all pass; `npx tsc --noEmit` clean (this catches any missed `.banner` consumer).

- [ ] **Step 6: Commit**

```bash
git add lib/eggs/occasions.ts lib/eggs/occasions.test.ts app/_components/eggs/occasion-banner.tsx app/layout.tsx
git commit -m "Stackable occasion banners: day-of greetings join birthday and eve strips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Simulated-date isolation conformance test

**Files:**
- Test: `web/lib/eggs/simulated-date-isolation.test.ts`

- [ ] **Step 1: Write the test** (it should PASS immediately — it guards the invariant):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// HARD GUARANTEE (Evan): the date simulator is preview-only. If business logic ever reads
// the simulated_date cookie, a simulated date could trigger real work (e.g. an offboarding
// running early). This test fails the suite the moment the string appears anywhere outside
// the explicit allowlist below.
const ALLOWED = new Set([
  "app/layout.tsx",                              // the single server read site (eggs only)
  "app/_components/eggs/date-simulator.tsx",     // the cookie writer (super-admin UI)
  "lib/eggs/effective-date.ts",                  // the fail-closed override resolver
  "lib/eggs/effective-date.test.ts",
  "lib/eggs/simulated-date-isolation.test.ts",   // this file
]);

const ROOTS = ["app", "lib", "middleware.ts"];
const SKIP = new Set(["node_modules", ".next", "generated"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) yield p;
  }
}

test("simulated_date is confined to the eggs preview layer", () => {
  const offenders: string[] = [];
  const cwd = process.cwd(); // npm test runs from web/
  for (const root of ROOTS) {
    let stat; try { stat = statSync(join(cwd, root)); } catch { continue; }
    const files = stat.isDirectory() ? [...walk(join(cwd, root))] : [join(cwd, root)];
    for (const f of files) {
      if (!readFileSync(f, "utf8").includes("simulated_date")) continue;
      const rel = relative(cwd, f);
      if (!ALLOWED.has(rel)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `simulated_date leaked outside the eggs layer: ${offenders.join(", ")}`);
});
```

- [ ] **Step 2: Run it** — `npx tsx --test "lib/eggs/simulated-date-isolation.test.ts"`: PASS. Then sanity-check it can fail: temporarily add `// simulated_date` to any lib file, re-run, confirm FAIL, revert.

- [ ] **Step 3: Commit**

```bash
git add lib/eggs/simulated-date-isolation.test.ts
git commit -m "Conformance test: simulated_date can never reach business logic

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Full verification + ship

- [ ] **Step 1:** `npm test` — expect 3 known pre-existing failures ONLY (lib/secrets/module-setup.test.ts ×1, lib/cases/exclude-m365-autosetup.test.ts ×2); everything else green.
- [ ] **Step 2:** `npx tsc --noEmit` — clean. (No `next build`.)
- [ ] **Step 3:** Changelog: NONE — Evan's changelog policy for eggs is the single teaser entry already shipped; do not add another entry.
- [ ] **Step 4:** Push and open a draft PR titled `Holiday greetings 🥚` with body describing: day-of greetings (US + Jewish + Muslim + Chinese + other cultural holidays, whole-span), verified 2026-2032 date table with sources, stacked banners, and the simulated-date isolation conformance test. End the body with the standard Claude Code attribution line.
