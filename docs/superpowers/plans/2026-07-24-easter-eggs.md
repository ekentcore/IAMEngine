# Easter Eggs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship nine cosmetic easter eggs (birthday banner, holiday-eve banner, holiday bulb, New Year confetti, Konami code, console signature, /credits, logo 7-click, milestone case sparkle) plus a super-admin date simulator, per `docs/superpowers/specs/2026-07-24-easter-eggs-design.md`.

**Architecture:** All date logic is pure and centralized in `web/lib/eggs/` (unit-tested with node:test via `tsx --test`). The root layout (`web/app/layout.tsx`) resolves an "effective egg date" (real Eastern date, or a `simulated_date` cookie when the real user is super_admin) and passes derived props into small client components. No DB changes, no business logic touched.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, node:test via `tsx --test` (run from `web/`). No new npm dependencies.

## Global Constraints

- Working dir for all commands: `/Users/evankent/coding/newuserscript/.claude/worktrees/easter-eggs/web` (branch `worktree-easter-eggs`).
- Test command: `npx tsx --test "lib/eggs/*.test.ts"` (scoped) and `npm test` (full suite) — node:test style (`import { test } from "node:test"; import assert from "node:assert/strict";`).
- **Do NOT run `next build`** — it is broken on main for a pre-existing reason (cutover/next-headers). Verify via tests; `next dev` only if needed, never while another dev server runs.
- No new npm packages. No Prisma schema changes. No `web/middleware` changes.
- Banner copy is exact and uppercase per spec: `HAPPY BIRTHDAY TO MY CREATOR - EVAN KENT`, `HAPPY BIRTHDAY TOMORROW TO MY CREATOR - EVAN KENT`, `HAPPY BELATED BIRTHDAY TO MY CREATOR - EVAN KENT`, `I HOPE YOU HAVE TOMORROW OFF FOR <HOLIDAY NAME UPPERCASE>`.
- Changelog entry title is exactly `Easters Eggs - Have fun!` — no detail items beyond a single `"🥚"`.
- All date checks are calendar dates in **America/New_York**.
- The `simulated_date` cookie affects ONLY the eggs module and only for a real (non-impersonated) `super_admin`; when auth is disabled (dev), treat as super_admin (matches `lib/auth/acting.ts` convention).
- UI follows the existing flat style: inline styles, patterns copied from `agent-update-banner.tsx` / `impersonation-banner.tsx` / `feature-request-button.tsx`.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Pure occasion logic — `lib/eggs/occasions.ts`

**Files:**
- Create: `web/lib/eggs/occasions.ts`
- Test: `web/lib/eggs/occasions.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 5, 6, 9):
  - `type EggBanner = { kind: "birthday" | "holiday-eve"; message: string }`
  - `type EggState = { banner: EggBanner | null; bulbGlyph: string; newYear: boolean }`
  - `occasionsFor(date: string): EggState` — `date` is `YYYY-MM-DD`
  - `isMilestoneCase(caseNumber: string | null | undefined): boolean`

- [ ] **Step 1: Write the failing tests**

Create `web/lib/eggs/occasions.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { occasionsFor, isMilestoneCase } from "./occasions";

// ---- Birthday banner (Nov 14; Sat -> also Nov 13 "TOMORROW"; Sun -> also Nov 15 "BELATED") ----

test("birthday: Nov 14 always shows the main message", () => {
  for (const d of ["2026-11-14", "2027-11-14", "2028-11-14"]) {
    assert.deepEqual(occasionsFor(d).banner, {
      kind: "birthday",
      message: "HAPPY BIRTHDAY TO MY CREATOR - EVAN KENT",
    });
  }
});

test("birthday on a Saturday (2026): Nov 13 shows TOMORROW variant", () => {
  assert.deepEqual(occasionsFor("2026-11-13").banner, {
    kind: "birthday",
    message: "HAPPY BIRTHDAY TOMORROW TO MY CREATOR - EVAN KENT",
  });
  assert.equal(occasionsFor("2026-11-15").banner, null); // Sunday after a Saturday birthday: nothing
});

test("birthday on a Sunday (2027): Nov 15 shows BELATED variant", () => {
  assert.deepEqual(occasionsFor("2027-11-15").banner, {
    kind: "birthday",
    message: "HAPPY BELATED BIRTHDAY TO MY CREATOR - EVAN KENT",
  });
  assert.equal(occasionsFor("2027-11-13").banner, null); // Saturday before a Sunday birthday: nothing
});

test("birthday on a weekday (2028, Tuesday): 13th and 15th show nothing", () => {
  assert.equal(occasionsFor("2028-11-13").banner, null);
  assert.equal(occasionsFor("2028-11-15").banner, null);
});

// ---- Holiday-eve banner ----
// Rules: holiday Tue-Fri -> show previous day; Sat -> show Thursday; Sun -> show Friday; Mon -> show Friday.

test("Thanksgiving 2026 (Thu Nov 26): eve shows Wed Nov 25", () => {
  assert.deepEqual(occasionsFor("2026-11-25").banner, {
    kind: "holiday-eve",
    message: "I HOPE YOU HAVE TOMORROW OFF FOR THANKSGIVING",
  });
  assert.equal(occasionsFor("2026-11-24").banner, null);
});

test("July 4 2026 is a Saturday: eve shows Thursday July 2", () => {
  assert.deepEqual(occasionsFor("2026-07-02").banner, {
    kind: "holiday-eve",
    message: "I HOPE YOU HAVE TOMORROW OFF FOR INDEPENDENCE DAY",
  });
  assert.equal(occasionsFor("2026-07-03").banner, null); // Friday assumed observed off
});

test("July 4 2027 is a Sunday: eve shows Friday July 2", () => {
  assert.equal(occasionsFor("2027-07-02").banner?.message, "I HOPE YOU HAVE TOMORROW OFF FOR INDEPENDENCE DAY");
  assert.equal(occasionsFor("2027-07-03").banner, null);
});

test("Memorial Day 2027 (Mon May 31): eve shows Friday May 28", () => {
  assert.equal(occasionsFor("2027-05-28").banner?.message, "I HOPE YOU HAVE TOMORROW OFF FOR MEMORIAL DAY");
  assert.equal(occasionsFor("2027-05-30").banner, null);
});

test("Christmas 2026 (Fri Dec 25): eve shows Thursday Dec 24", () => {
  assert.equal(occasionsFor("2026-12-24").banner?.message, "I HOPE YOU HAVE TOMORROW OFF FOR CHRISTMAS");
});

test("New Year's Day 2028 (Sat Jan 1): eve shows Thursday Dec 30 2027 (crosses the year boundary)", () => {
  assert.equal(occasionsFor("2027-12-30").banner?.message, "I HOPE YOU HAVE TOMORROW OFF FOR NEW YEAR'S DAY");
});

test("an ordinary day has no banner", () => {
  assert.equal(occasionsFor("2026-07-24").banner, null);
});

// ---- Bulb glyph ----

test("bulb glyph windows", () => {
  assert.equal(occasionsFor("2026-10-25").bulbGlyph, "🎃");
  assert.equal(occasionsFor("2026-10-31").bulbGlyph, "🎃");
  assert.equal(occasionsFor("2026-10-24").bulbGlyph, "💡");
  assert.equal(occasionsFor("2026-12-20").bulbGlyph, "🎄");
  assert.equal(occasionsFor("2026-12-26").bulbGlyph, "🎄");
  assert.equal(occasionsFor("2026-12-31").bulbGlyph, "🎆");
  assert.equal(occasionsFor("2027-01-01").bulbGlyph, "🎆");
  assert.equal(occasionsFor("2026-07-24").bulbGlyph, "💡");
});

// ---- New Year window ----

test("newYear is true only Jan 1-2", () => {
  assert.equal(occasionsFor("2027-01-01").newYear, true);
  assert.equal(occasionsFor("2027-01-02").newYear, true);
  assert.equal(occasionsFor("2027-01-03").newYear, false);
});

// ---- Milestone case ----

test("isMilestoneCase: trailing number multiple of 1000", () => {
  assert.equal(isMilestoneCase("IAM0001000"), true);
  assert.equal(isMilestoneCase("UM0030000"), true);
  assert.equal(isMilestoneCase("IAM0001001"), false);
  assert.equal(isMilestoneCase("UM0029763"), false);
  assert.equal(isMilestoneCase("IAM0000000"), false); // zero is not a milestone
  assert.equal(isMilestoneCase(null), false);
  assert.equal(isMilestoneCase(undefined), false);
  assert.equal(isMilestoneCase("no-digits"), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/evankent/coding/newuserscript/.claude/worktrees/easter-eggs/web && npx tsx --test "lib/eggs/occasions.test.ts"`
Expected: FAIL — cannot find module `./occasions`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/eggs/occasions.ts`:

```ts
// Easter-egg occasion logic — pure calendar math, no I/O. Every date-driven egg (birthday banner,
// holiday-eve banner, holiday bulb glyph, New Year confetti) resolves through occasionsFor(date),
// so the super-admin date simulator exercises all of them. Dates are "YYYY-MM-DD" calendar dates;
// timezone resolution happens upstream in effective-date.ts. See
// docs/superpowers/specs/2026-07-24-easter-eggs-design.md for the full spec.

export type EggBanner = { kind: "birthday" | "holiday-eve"; message: string };
export type EggState = { banner: EggBanner | null; bulbGlyph: string; newYear: boolean };

function parts(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Local-time Date for pure calendar math (weekday, day arithmetic). Never used for "now".
function toDate(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

function addDays(date: Date, delta: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + delta);
  return out;
}

function lastMondayOfMay(y: number): Date {
  const d = toDate(y, 5, 31);
  while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  return d;
}

function firstMondayOfSeptember(y: number): Date {
  const d = toDate(y, 9, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d;
}

function fourthThursdayOfNovember(y: number): Date {
  const d = toDate(y, 11, 1);
  while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
  return addDays(d, 21);
}

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
  if (!p) return { banner: null, bulbGlyph: "💡", newYear: false };
  // Birthday wins if both would ever apply — only one occasion banner renders.
  const banner = birthdayBanner(date, p.y) ?? holidayEveBanner(date, p.y);
  return {
    banner,
    bulbGlyph: bulbGlyph(p.m, p.d),
    newYear: p.m === 1 && p.d <= 2,
  };
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test "lib/eggs/occasions.test.ts"`
Expected: PASS, all tests green. (If a holiday-eve test fails, check the weekday math against a calendar before touching the shift rules — the expectations in Step 1 use verified real dates.)

- [ ] **Step 5: Commit**

```bash
git add lib/eggs/occasions.ts lib/eggs/occasions.test.ts
git commit -m "Add pure easter-egg occasion logic (birthday, holiday-eve, bulb, milestone)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Effective egg date — `lib/eggs/effective-date.ts`

**Files:**
- Create: `web/lib/eggs/effective-date.ts`
- Test: `web/lib/eggs/effective-date.test.ts`

**Interfaces:**
- Produces (consumed by Task 5's layout wiring):
  - `todayEastern(now?: Date): string` — today's `YYYY-MM-DD` in America/New_York
  - `effectiveEggDate(simCookie: string | undefined, isSuperAdmin: boolean, now?: Date): string`

- [ ] **Step 1: Write the failing tests**

Create `web/lib/eggs/effective-date.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { todayEastern, effectiveEggDate } from "./effective-date";

test("todayEastern formats the Eastern calendar date, not UTC", () => {
  // 02:00 UTC on Jul 25 is still 22:00 Jul 24 in New York (EDT, UTC-4).
  assert.equal(todayEastern(new Date("2026-07-25T02:00:00Z")), "2026-07-24");
  assert.equal(todayEastern(new Date("2026-07-24T12:00:00-04:00")), "2026-07-24");
  // Winter (EST, UTC-5): 04:30 UTC Jan 2 is 23:30 Jan 1 in New York.
  assert.equal(todayEastern(new Date("2027-01-02T04:30:00Z")), "2027-01-01");
});

test("simulated date is honored only for a super admin", () => {
  const now = new Date("2026-07-24T12:00:00-04:00");
  assert.equal(effectiveEggDate("2026-11-14", true, now), "2026-11-14");
  assert.equal(effectiveEggDate("2026-11-14", false, now), "2026-07-24");
  assert.equal(effectiveEggDate(undefined, true, now), "2026-07-24");
});

test("garbage cookie values are ignored", () => {
  const now = new Date("2026-07-24T12:00:00-04:00");
  assert.equal(effectiveEggDate("not-a-date", true, now), "2026-07-24");
  assert.equal(effectiveEggDate("2026-13-40", true, now), "2026-07-24"); // not a real calendar date
  assert.equal(effectiveEggDate("2026-02-30", true, now), "2026-07-24"); // Feb 30 would roll over
  assert.equal(effectiveEggDate("", true, now), "2026-07-24");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test "lib/eggs/effective-date.test.ts"`
Expected: FAIL — cannot find module `./effective-date`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/eggs/effective-date.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test "lib/eggs/effective-date.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/eggs/effective-date.ts lib/eggs/effective-date.test.ts
git commit -m "Add override-aware effective date for easter eggs (Eastern, super-admin cookie)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Konami sequence matcher — `lib/eggs/konami.ts`

**Files:**
- Create: `web/lib/eggs/konami.ts`
- Test: `web/lib/eggs/konami.test.ts`

**Interfaces:**
- Produces (consumed by Task 4's `KonamiEgg` component):
  - `KONAMI_LENGTH: number` (10)
  - `advanceKonami(progress: number, key: string): number` — feed `KeyboardEvent.key` values; returns new progress; `KONAMI_LENGTH` means the code completed (caller resets to 0).

- [ ] **Step 1: Write the failing tests**

Create `web/lib/eggs/konami.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceKonami, KONAMI_LENGTH } from "./konami";

const SEQ = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

test("the full sequence completes", () => {
  let p = 0;
  for (const k of SEQ) p = advanceKonami(p, k);
  assert.equal(p, KONAMI_LENGTH);
});

test("keys are case-insensitive for B and A", () => {
  let p = 0;
  for (const k of ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "B", "A"]) {
    p = advanceKonami(p, k);
  }
  assert.equal(p, KONAMI_LENGTH);
});

test("a wrong key resets progress (but a fresh ArrowUp restarts the sequence)", () => {
  let p = 0;
  p = advanceKonami(p, "ArrowUp");
  p = advanceKonami(p, "ArrowUp");
  p = advanceKonami(p, "x");
  assert.equal(p, 0);
  // A wrong key that IS the first key restarts at 1, not 0.
  p = advanceKonami(2, "ArrowUp");
  assert.equal(p, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test "lib/eggs/konami.test.ts"`
Expected: FAIL — cannot find module `./konami`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/eggs/konami.ts`:

```ts
// Konami-code state machine, pure so it's testable without a browser. Feed KeyboardEvent.key
// values; when the return value hits KONAMI_LENGTH the code completed and the caller resets.

const SEQ = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];

export const KONAMI_LENGTH = SEQ.length;

export function advanceKonami(progress: number, key: string): number {
  const k = key.toLowerCase();
  if (k === SEQ[progress]) return progress + 1;
  return k === SEQ[0] ? 1 : 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test "lib/eggs/konami.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/eggs/konami.ts lib/eggs/konami.test.ts
git commit -m "Add pure Konami-code sequence matcher

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Client egg components — confetti, Konami, console signature, New Year

**Files:**
- Create: `web/app/_components/eggs/confetti.ts`
- Create: `web/app/_components/eggs/egg-toast.tsx`
- Create: `web/app/_components/eggs/konami-egg.tsx`
- Create: `web/app/_components/eggs/console-signature.tsx`
- Create: `web/app/_components/eggs/new-year-egg.tsx`
- Modify: `web/app/globals.css` (append at end of file)

**Interfaces:**
- Consumes: `advanceKonami`, `KONAMI_LENGTH` from `@/lib/eggs/konami` (Task 3).
- Produces (consumed by Task 5's layout wiring):
  - `fireConfetti(): void` (imperative, browser-only)
  - `<KonamiEgg />` (no props)
  - `<ConsoleSignature />` (no props)
  - `<NewYearEgg year={string} />` — `year` is the 4-digit year of the effective egg date

There is no React component test runner in this repo (node:test only), so these components carry no unit tests; their pure logic was tested in Tasks 1–3 and they are exercised manually in Task 11 via the simulator.

- [ ] **Step 1: Create the confetti module**

Create `web/app/_components/eggs/confetti.ts`:

```ts
// Dependency-free canvas confetti (~2s burst). Imperative on purpose: eggs call fireConfetti()
// from event handlers/effects. Creates a full-screen canvas, animates, removes itself. Browser-only.

const COLORS = ["#f59e0b", "#ef4444", "#3b82f6", "#22c55e", "#a855f7", "#ec4899"];

export function fireConfetti(): void {
  if (typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.remove(); return; }

  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    vy: 2 + Math.random() * 3.5,
    vx: -1.5 + Math.random() * 3,
    rot: Math.random() * Math.PI,
    vr: -0.1 + Math.random() * 0.2,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));

  const started = performance.now();
  function frame(now: number) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.y += p.vy;
      p.x += p.vx;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now - started < 2200) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}
```

- [ ] **Step 2: Create the toast component**

Create `web/app/_components/eggs/egg-toast.tsx`:

```tsx
"use client";

// Tiny fixed toast used by the egg components (Konami, New Year). Self-dismisses.
import { useEffect } from "react";

export function EggToast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      role="status"
      style={{
        position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 9999,
        background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10,
        padding: "0.6rem 1rem", fontSize: 13, boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))",
        whiteSpace: "nowrap",
      }}
    >
      {message}
    </div>
  );
}
```

- [ ] **Step 3: Create the Konami egg**

Create `web/app/_components/eggs/konami-egg.tsx`:

```tsx
"use client";

// ↑↑↓↓←→←→BA anywhere -> confetti + a credit toast. Ignores keystrokes while typing in a field.
import { useEffect, useRef, useState } from "react";
import { advanceKonami, KONAMI_LENGTH } from "@/lib/eggs/konami";
import { fireConfetti } from "./confetti";
import { EggToast } from "./egg-toast";

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

export function KonamiEgg() {
  const progress = useRef(0);
  const [hit, setHit] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      progress.current = advanceKonami(progress.current, e.key);
      if (progress.current === KONAMI_LENGTH) {
        progress.current = 0;
        fireConfetti();
        setHit(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!hit) return null;
  return <EggToast message="IAM Engine — built by Evan Kent, 2026 · see /credits" onDone={() => setHit(false)} />;
}
```

- [ ] **Step 4: Create the console signature**

Create `web/app/_components/eggs/console-signature.tsx`:

```tsx
"use client";

// One styled console.log per page load — a signature for whoever opens dev tools.
import { useEffect } from "react";

let printed = false;

export function ConsoleSignature() {
  useEffect(() => {
    if (printed) return;
    printed = true;
    // eslint-disable-next-line no-console
    console.log(
      "%c  iam-engine  %c\n\nCrafted by Evan Kent · 2026.\nDebugging? Check /docs first.\n",
      "background:#1e293b;color:#f59e0b;font-size:16px;font-weight:bold;padding:4px 8px;border-radius:4px",
      ""
    );
  }, []);
  return null;
}
```

- [ ] **Step 5: Create the New Year egg**

Create `web/app/_components/eggs/new-year-egg.tsx`:

```tsx
"use client";

// Jan 1-2: one confetti burst per user per year (localStorage-guarded). Rendered only when the
// layout's occasion state says the new-year window is active.
import { useEffect, useState } from "react";
import { fireConfetti } from "./confetti";
import { EggToast } from "./egg-toast";

export function NewYearEgg({ year }: { year: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const key = `iam-eggs-newyear-${year}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return; // storage unavailable -> skip rather than fire on every load
    }
    fireConfetti();
    setShow(true);
  }, [year]);

  if (!show) return null;
  return <EggToast message={`Happy New Year from IAM Engine 🎆 (${year})`} onDone={() => setShow(false)} />;
}
```

- [ ] **Step 6: Append egg animations to globals.css**

Append at the very end of `web/app/globals.css`:

```css
/* --- easter eggs --- */
@keyframes egg-fall {
  from { transform: translateY(-1.4em); opacity: 0.9; }
  to { transform: translateY(1.6em); opacity: 0; }
}
.egg-fall { display: inline-block; animation: egg-fall 2.6s linear infinite; }
@keyframes egg-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.egg-spin { display: inline-block; animation: egg-spin 0.7s ease-in-out 1; }
```

- [ ] **Step 7: Type-check the new files**

Run: `npx tsc --noEmit`
Expected: no NEW errors compared to `git stash && npx tsc --noEmit; git stash pop` baseline (the repo may have pre-existing errors; only compare). If baseline is clean, expect clean.

- [ ] **Step 8: Commit**

```bash
git add app/_components/eggs/confetti.ts app/_components/eggs/egg-toast.tsx app/_components/eggs/konami-egg.tsx app/_components/eggs/console-signature.tsx app/_components/eggs/new-year-egg.tsx app/globals.css
git commit -m "Add egg client components: confetti, toast, Konami, console signature, New Year

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Occasion banner + bulb glyph + layout wiring

**Files:**
- Create: `web/app/_components/eggs/occasion-banner.tsx`
- Modify: `web/app/_components/feature-request-button.tsx` (glyph prop; button at lines 62-70)
- Modify: `web/app/layout.tsx` (imports; egg-state computation after line 57; bulb glyph at line 89; mounts after line 97)

**Interfaces:**
- Consumes: `occasionsFor`, `EggBanner` (Task 1); `effectiveEggDate` (Task 2); `<KonamiEgg />`, `<ConsoleSignature />`, `<NewYearEgg />` (Task 4).
- Produces: `<OccasionBanner banner={EggBanner} />`; `FeatureRequestButton` gains optional prop `glyph?: string` (default `"💡"`). Layout exposes nothing new to other tasks, but Task 6 modifies the same regions — implementers should re-read `layout.tsx` before editing.

- [ ] **Step 1: Create the occasion banner**

Create `web/app/_components/eggs/occasion-banner.tsx`:

```tsx
// Full-width occasion strip (birthday / holiday-eve), mounted by the root layout next to the other
// global banners. Server-renderable — the animation is pure CSS (.egg-fall in globals.css).
import type { EggBanner } from "@/lib/eggs/occasions";

const LOOK: Record<EggBanner["kind"], { bg: string; border: string; color: string; emoji: string }> = {
  birthday: { bg: "#fdf2f8", border: "#fbcfe8", color: "#9d174d", emoji: "🎂" },
  "holiday-eve": { bg: "#f0fdf4", border: "#bbf7d0", color: "#166534", emoji: "🎉" },
};

export function OccasionBanner({ banner }: { banner: EggBanner }) {
  const look = LOOK[banner.kind];
  return (
    <div
      role="status"
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 10, overflow: "hidden",
        padding: "0.5rem 1rem", background: look.bg, borderBottom: `1px solid ${look.border}`,
        color: look.color, fontSize: 13, fontWeight: 600, textAlign: "center",
      }}
    >
      <span className="egg-fall" aria-hidden>{look.emoji}</span>
      <span>{banner.message}</span>
      <span className="egg-fall" aria-hidden style={{ animationDelay: "1.1s" }}>{look.emoji}</span>
    </div>
  );
}
```

- [ ] **Step 2: Add the glyph prop to the 💡 button**

In `web/app/_components/feature-request-button.tsx`, change the component signature (line 25) and the button glyph (line 69):

```tsx
export function FeatureRequestButton({ glyph = "💡" }: { glyph?: string } = {}) {
```

and inside the button JSX replace the literal `💡` child with:

```tsx
        {glyph}
```

(The `title`/`aria-label` stay "Request a feature" — the button's function is unchanged; only the glyph is seasonal.)

- [ ] **Step 3: Wire the layout**

In `web/app/layout.tsx`:

**3a.** Add imports after line 21 (`openFeatureRequestCount` import):

```tsx
import { occasionsFor } from "@/lib/eggs/occasions";
import { effectiveEggDate } from "@/lib/eggs/effective-date";
import { OccasionBanner } from "./_components/eggs/occasion-banner";
import { KonamiEgg } from "./_components/eggs/konami-egg";
import { ConsoleSignature } from "./_components/eggs/console-signature";
import { NewYearEgg } from "./_components/eggs/new-year-egg";
```

**3b.** After the `openFeatureRequests` computation (line 57), add:

```tsx
  // Easter eggs (see docs/superpowers/specs/2026-07-24-easter-eggs-design.md). The simulated_date
  // cookie is honored only for the REAL super-admin (auth off = dev = synthetic super), and only
  // decides which eggs render — nothing else reads it.
  const isRealSuperAdmin = !authEnabled() || acting.realUser?.role === "super_admin";
  const simCookie = cookies().get("simulated_date")?.value;
  const eggDate = effectiveEggDate(simCookie, isRealSuperAdmin);
  const eggs = loggedIn && !onLogin ? occasionsFor(eggDate) : { banner: null, bulbGlyph: "💡", newYear: false };
```

**3c.** Change line 89 to pass the glyph:

```tsx
              {(!authEnabled() || !!user) && <FeatureRequestButton glyph={eggs.bulbGlyph} />}
```

**3d.** After the `AgentUpdateBanner` line (line 97), before `{children}`, add:

```tsx
        {eggs.banner && <OccasionBanner banner={eggs.banner} />}
        {loggedIn && !onLogin && (
          <>
            <KonamiEgg />
            <ConsoleSignature />
            {eggs.newYear && <NewYearEgg year={eggDate.slice(0, 4)} />}
          </>
        )}
```

- [ ] **Step 4: Verify**

Run: `npx tsx --test "lib/eggs/*.test.ts" && npx tsc --noEmit`
Expected: egg tests PASS; no new type errors versus baseline.

- [ ] **Step 5: Commit**

```bash
git add app/_components/eggs/occasion-banner.tsx app/_components/feature-request-button.tsx app/layout.tsx
git commit -m "Wire occasion banner, holiday bulb glyph, and ambient eggs into the layout

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Super-admin date simulator (📅 button + indicator strip)

**Files:**
- Create: `web/app/_components/eggs/date-simulator.tsx`
- Modify: `web/app/layout.tsx` (button before line with `<FeatureRequestButton`; strip next to the other banners)

**Interfaces:**
- Consumes: layout's `isRealSuperAdmin`, `simCookie`, `eggDate` (Task 5).
- Produces: `<DateSimulatorButton current={string | undefined} />` and `<SimulatedDateStrip date={string} />` (both client components in one file).

- [ ] **Step 1: Create the simulator components**

Create `web/app/_components/eggs/date-simulator.tsx`:

```tsx
"use client";

// Super-admin 📅 button (left of the 💡): pick a date and the app's EASTER EGGS act as if it's
// that date — nothing else does. Cookie-based (ThemeToggle pattern), session-scoped, and the
// server honors it only for a real super_admin (fail-closed). The strip makes the state obvious.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 };
const cardStyle: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", width: "min(380px, calc(100vw - 2rem))", boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" };

function setSimCookie(value: string | null) {
  document.cookie = value
    ? `simulated_date=${value}; path=/; samesite=lax`
    : "simulated_date=; path=/; max-age=0; samesite=lax";
}

export function DateSimulatorButton({ current }: { current?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current ?? "");

  function apply() {
    if (value) setSimCookie(value);
    setOpen(false);
    router.refresh();
  }
  function reset() {
    setSimCookie(null);
    setValue("");
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        title="Simulate a date (easter-egg preview)"
        aria-label="Simulate a date"
        onClick={() => setOpen(true)}
        style={{ padding: "0.15rem 0.4rem", fontSize: 14, lineHeight: 1 }}
      >
        📅
      </button>
      {open &&
        createPortal(
          <div role="dialog" aria-modal="true" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
            <div style={cardStyle}>
              <h2 style={{ margin: "0 0 0.25rem" }}>Simulate a date</h2>
              <p className="note" style={{ marginTop: 0 }}>
                The app&rsquo;s easter eggs will act as if it&rsquo;s this date. Nothing else changes — cases, jobs, and audit all keep real time.
              </p>
              <input
                type="date"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                style={{ width: "100%", marginBottom: "0.8rem" }}
                autoFocus
              />
              <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button onClick={() => setOpen(false)}>Cancel</button>
                {current && <button onClick={reset}>Reset to today</button>}
                <button className="primary" disabled={!value} onClick={apply}>Apply</button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

export function SimulatedDateStrip({ date }: { date: string }) {
  const router = useRouter();
  return (
    <div style={{ background: "#4c1d95", color: "#fff", padding: "0.35rem 1rem", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 12 }}>
      <span>📅 Simulated date: <strong>{date}</strong> — easter-egg preview only</span>
      <button
        type="button"
        style={{ fontSize: 12, padding: "0.15rem 0.6rem", background: "#fff", color: "#4c1d95", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}
        onClick={() => { setSimCookie(null); router.refresh(); }}
      >
        Reset
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire into the layout**

In `web/app/layout.tsx`:

**2a.** Add to the eggs import block (from Task 5 step 3a):

```tsx
import { DateSimulatorButton, SimulatedDateStrip } from "./_components/eggs/date-simulator";
```

**2b.** After the `eggs` computation (Task 5 step 3b), add:

```tsx
  const simActive = isRealSuperAdmin && !!simCookie && eggDate === simCookie;
```

(`eggDate === simCookie` is true only when the cookie was valid and honored — garbage cookies show no strip.)

**2c.** In the header's right-side flex group, insert the 📅 button on the line **before** `<FeatureRequestButton`, gated on the REAL super-admin so impersonation can't grant it:

```tsx
              {isRealSuperAdmin && !onLogin && <DateSimulatorButton current={simActive ? simCookie : undefined} />}
```

**2d.** Immediately **before** the `{eggs.banner && <OccasionBanner ...}` line (Task 5 step 3d), add:

```tsx
        {simActive && <SimulatedDateStrip date={eggDate} />}
```

- [ ] **Step 3: Verify**

Run: `npx tsx --test "lib/eggs/*.test.ts" && npx tsc --noEmit`
Expected: PASS / no new type errors.

- [ ] **Step 4: Commit**

```bash
git add app/_components/eggs/date-simulator.tsx app/layout.tsx
git commit -m "Add super-admin date simulator button and active-simulation strip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Logo 7-click — brand title

**Files:**
- Create: `web/app/_components/eggs/brand-title.tsx`
- Modify: `web/app/layout.tsx:67` (replace the brand `<Link>`)

**Interfaces:**
- Produces: `<BrandTitle />` — drop-in replacement for `<Link href="/clients" className="brand">iam-engine</Link>`.

- [ ] **Step 1: Create the component**

Create `web/app/_components/eggs/brand-title.tsx`:

```tsx
"use client";

// The header brand link, with a secret: 7 clicks within 3 seconds spins it once and renames the
// app "Evan's IAM Engine" until the next full navigation. Still a working link to /clients.
import { useRef, useState } from "react";
import Link from "next/link";

export function BrandTitle() {
  const clicks = useRef<number[]>([]);
  const [egg, setEgg] = useState(false);

  function onClick() {
    const now = performance.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 3000), now];
    if (clicks.current.length >= 7) {
      clicks.current = [];
      setEgg(true);
    }
  }

  return (
    <Link href="/clients" className="brand" onClick={onClick}>
      <span className={egg ? "egg-spin" : undefined}>{egg ? "Evan's IAM Engine" : "iam-engine"}</span>
    </Link>
  );
}
```

- [ ] **Step 2: Swap it into the layout**

In `web/app/layout.tsx`, add the import to the eggs block:

```tsx
import { BrandTitle } from "./_components/eggs/brand-title";
```

and replace line 67 (`<Link href="/clients" className="brand">iam-engine</Link>`) with:

```tsx
            <BrandTitle />
```

(If `Link` is then unused in `layout.tsx`, remove its import at line 2.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no new type errors (in particular no unused-import lint on `Link`).

- [ ] **Step 4: Commit**

```bash
git add app/_components/eggs/brand-title.tsx app/layout.tsx
git commit -m "Brand title easter egg: 7 clicks spins it into Evan's IAM Engine

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: /credits page

**Files:**
- Create: `web/app/credits/page.tsx`

**Interfaces:** none — standalone unlinked route. The root layout already bounces logged-out visitors to /login, so no extra auth code.

- [ ] **Step 1: Create the page**

Create `web/app/credits/page.tsx`:

```tsx
// An unlinked credits page — the Konami toast is the breadcrumb that reveals it. Static text on
// purpose (no queries): it's a plaque, not a dashboard.
export const metadata = { title: "Credits" };

const line: React.CSSProperties = { margin: "0.2rem 0" };
const label: React.CSSProperties = { ...line, opacity: 0.6, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.12em", marginTop: "1.6rem" };

export default function CreditsPage() {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "4rem 1.5rem", textAlign: "center" }}>
      <p style={{ ...line, fontSize: 12, letterSpacing: "0.3em", opacity: 0.6 }}>IAM ENGINE PRESENTS</p>
      <h1 style={{ margin: "0.6rem 0 0" }}>The IAM lifecycle automation platform</h1>

      <p style={label}>Created by</p>
      <p style={{ ...line, fontSize: 20, fontWeight: 700 }}>Evan Kent</p>

      <p style={label}>Starring</p>
      <p style={line}>A web app (the brain) · a PowerShell runner fleet (the hands)</p>
      <p style={line}>and ~200 client orgs (the audience)</p>

      <p style={label}>By the numbers</p>
      <p style={line}>240+ pull requests · runner 1.0 → 1.96 · 254 client profiles distilled to data</p>

      <p style={label}>Built with</p>
      <p style={line}>Next.js · Prisma · PostgreSQL · PowerShell 7 · stubbornness</p>

      <p style={label}>In loving memory of</p>
      <p style={line}>every runbook that was a Word document</p>

      <p style={{ ...line, marginTop: "2.4rem", opacity: 0.7 }}>
        &ldquo;Every executor is idempotent.&rdquo;
      </p>
      <p style={{ ...line, marginTop: "1.6rem" }} aria-hidden>🥚</p>
    </main>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add app/credits/page.tsx
git commit -m "Add unlinked /credits page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Milestone case sparkle

**Files:**
- Modify: `web/app/cases/[id]/page.tsx:139`

**Interfaces:**
- Consumes: `isMilestoneCase` from `@/lib/eggs/occasions` (Task 1).

- [ ] **Step 1: Add the sparkle**

In `web/app/cases/[id]/page.tsx`, add the import near the other `@/lib` imports at the top of the file:

```tsx
import { isMilestoneCase } from "@/lib/eggs/occasions";
```

Then at line 139, change:

```tsx
            {c.serviceNowCaseNumber ?? "no SN case"} · <span className="badge">{c.status.replace("_", " ")}</span>
```

to:

```tsx
            {c.serviceNowCaseNumber ?? "no SN case"}
            {isMilestoneCase(c.serviceNowCaseNumber) && <span title="milestone case" aria-label="milestone case"> ✨</span>}
            {" · "}<span className="badge">{c.status.replace("_", " ")}</span>
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add "app/cases/[id]/page.tsx"
git commit -m "Sparkle on milestone case numbers (every 1000th case)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Changelog entry — "Easters Eggs - Have fun!"

**Files:**
- Create: `web/lib/changelog/entries/easter-eggs.ts`
- Modify: `web/lib/changelog/entries/_registry.ts` (one export line, alphabetical by id)

**Interfaces:** follows `ChangelogEntry` from `web/lib/changelog/format.ts`.

- [ ] **Step 1: Get the ship time**

Run: `TZ=America/New_York date +%H:%M`
Round DOWN to a 15-minute boundary (e.g. 14:52 → `14:45`) and use it below. Also confirm today's Eastern date with `TZ=America/New_York date +%F`.

- [ ] **Step 2: Create the entry**

Create `web/lib/changelog/entries/easter-eggs.ts` (substitute the real time from step 1):

```ts
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "easter-eggs",
  date: "2026-07-24",
  time: "12:00",
  title: "Easters Eggs - Have fun!",
  items: ["🥚"],
};
```

(The title is deliberately exact and the single item deliberately unspoiled — per the spec's changelog policy. The detail lives in `docs/superpowers/specs/2026-07-24-easter-eggs-design.md`.)

- [ ] **Step 3: Register it**

In `web/lib/changelog/entries/_registry.ts`, insert this line in alphabetical position by id (after the last `d…`/before the first `e…`-or-later export — search for where `easter-eggs` sorts):

```ts
export { entry as easterEggs } from "./easter-eggs";
```

- [ ] **Step 4: Run the registry test**

Run: `npx tsx --test "lib/changelog/entries/registry.test.ts" "lib/changelog/entries.test.ts"`
Expected: PASS (registry.test.ts fails if the entry file and _registry.ts are out of sync; entries.test.ts validates the entry shape, date, and 15-minute time boundary).

- [ ] **Step 5: Commit**

```bash
git add lib/changelog/entries/easter-eggs.ts lib/changelog/entries/_registry.ts
git commit -m "Changelog: Easters Eggs - Have fun!

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification + ship

**Files:** none new.

- [ ] **Step 1: Run the full web test suite**

Run: `cd /Users/evankent/coding/newuserscript/.claude/worktrees/easter-eggs/web && npm test`
Expected: all tests pass (1500+). Any failure in a file this plan touched must be fixed before shipping; pre-existing failures unrelated to `lib/eggs`, `lib/changelog`, or the modified pages should be confirmed pre-existing by running the same file on `main`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no NEW errors versus the pre-change baseline. Do NOT use `next build` as verification (broken on main, pre-existing).

- [ ] **Step 3: Manual smoke via the simulator (if a dev server is practical)**

Optional but preferred: start `npx next dev -p 3001` in the worktree (never alongside a running build), sign in as a super_admin (or auth-off dev mode), then use the 📅 button to check: `2026-11-13` (TOMORROW banner), `2026-11-14` (main banner), `2027-11-15` (BELATED), `2026-11-25` (Thanksgiving eve + animation), `2026-12-24` (eve + 🎄 bulb), `2027-01-01` (🎆 bulb + New Year confetti once), then Reset. Also: Konami code, 7 logo clicks, `/credits`, console signature in dev tools. Stop the dev server when done.

- [ ] **Step 4: Push and open a draft PR**

```bash
git push -u origin worktree-easter-eggs
gh pr create --draft --title "Easters Eggs - Have fun!" --body "$(cat <<'EOF'
A farewell collection of easter eggs. Spec: docs/superpowers/specs/2026-07-24-easter-eggs-design.md

- Date-driven eggs (birthday banner, holiday-eve banner, holiday bulb glyph, New Year confetti) resolve through pure, unit-tested logic in web/lib/eggs/
- Super-admin 📅 date simulator (left of the 💡) previews any date — eggs only, business logic untouched
- Plus: Konami code, console signature, /credits, logo 7-click, milestone case sparkle
- No new dependencies, no schema changes, no runner changes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: draft PR URL printed.
