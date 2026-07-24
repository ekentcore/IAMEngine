# Easter Eggs — design spec

**Date:** 2026-07-24
**Author:** Evan Kent (with Claude)
**Status:** Approved by Evan 2026-07-24

A farewell collection of nine small, tasteful easter eggs plus a super-admin
date-simulator to test the date-driven ones. All eggs are cosmetic: no business
logic (cases, jobs, audit, credentials) is touched, and the worst failure mode
of any egg is "banner doesn't render."

Changelog policy (per Evan, updated 2026-07-24 second batch): easter eggs get
**no changelog entry at all** — the original "Easters Eggs - Have fun!" teaser
and the crawl teaser were both removed. No separate easter-egg doc —
this spec is the only written detail.

## Core plumbing — `web/lib/eggs/`

- **`effective-date.ts`** — server helper returning today's calendar date in
  **America/New_York** (the app's Eastern convention, see
  `web/lib/changelog/format.ts`). If a `simulated_date` cookie
  (`YYYY-MM-DD`) is present **and** the real, non-impersonated user is
  `super_admin` (`acting.realUser?.role === "super_admin"`), it returns the
  cookie date instead. The override affects **only** the eggs module; nothing
  else reads it. No central `now()` exists in the app and none is introduced.
- **`occasions.ts`** — pure function `occasionsFor(date: string)` returning the
  set of active occasions (birthday banner + message variant, holiday-eve
  banner + holiday name, bulb glyph, new-year window). All weekend-shift rules
  live here. Fully unit-tested; no I/O.

## The eggs

### 1. Birthday banner
Every **November 14**: full-width top banner
`HAPPY BIRTHDAY TO MY CREATOR - EVAN KENT` 🎂.
- If Nov 14 falls on a **Saturday**, the banner also shows on **Nov 13** with
  `HAPPY BIRTHDAY TOMORROW TO MY CREATOR - EVAN KENT`.
- If Nov 14 falls on a **Sunday**, the banner also shows on **Nov 15** with
  `HAPPY BELATED BIRTHDAY TO MY CREATOR - EVAN KENT`.
- Mounts in `web/app/layout.tsx` alongside the existing
  `ImpersonationBanner`/`AgentUpdateBanner` (before `{children}`), hidden on
  `/login`. Styled festively but flat, per the design system; modeled on
  `agent-update-banner.tsx`.
- First real firing: Nov 14, 2026 is a Saturday, so the "TOMORROW" variant
  shows Friday Nov 13, 2026.

### 2. Super-admin date simulator
A small 📅 button in the header toolbar, **immediately left of the 💡**
(`FeatureRequestButton`, `web/app/layout.tsx` right-side flex group). Visible
only when the **real** user is `super_admin` — impersonation cannot grant it.
- Opens a popover (same `createPortal` overlay pattern as
  `feature-request-button.tsx`) with a date input and a **Reset** button.
- Picking a date writes `simulated_date=YYYY-MM-DD; path=/; samesite=lax`
  (session cookie, `ThemeToggle` cookie pattern) and calls `router.refresh()`.
- While active, a slim indicator strip (modeled on `impersonation-banner.tsx`)
  shows `Simulated date: <date> — reset` so it cannot be forgotten.
- Server-side, the cookie is honored only for super_admin (fail-closed).

### 3. Holiday-eve banner
For each **major holiday** — New Year's Day, Memorial Day, Independence Day,
Labor Day, Thanksgiving, Christmas (a constant list in `occasions.ts`, easy to
extend) — a banner reading
`I HOPE YOU HAVE TOMORROW OFF FOR <HOLIDAY>` with a gentle CSS-only
falling-emoji animation. Show rules:
- Holiday on Tue–Fri → banner shows the **previous day**.
- Holiday on **Saturday** → banner shows **Thursday** (Friday assumed
  observed off).
- Holiday on **Sunday** → banner shows **Friday**.
- Holiday on **Monday** → banner shows **Friday** (judgment call, approved:
  the literal day before is Sunday and nobody would see it).
- Floating holidays (Memorial Day = last Mon of May, Labor Day = first Mon of
  Sep, Thanksgiving = fourth Thu of Nov) are computed, not hardcoded per year.
- If the birthday banner and a holiday-eve banner ever both apply, the
  **birthday banner wins** (only one occasion banner renders).

### 4. Holiday light bulb
The 💡 feature-request button swaps its glyph — 🎃 Oct 25–31, 🎄 Dec 20–26,
🎆 Dec 31–Jan 1 — fully functional, just dressed up. Glyph is resolved
server-side in the layout from `occasionsFor(effectiveDate())` and passed as a
prop, so the simulator drives it too.

### 5. New Year confetti
On **Jan 1–2**, one confetti burst per user per year, with a small toast
"Happy New Year from IAM Engine". Once-per-year guard via
`localStorage` key `iam-eggs-newyear-<year>`.

### 6. Konami code
Typing ↑↑↓↓←→←→BA anywhere fires the confetti burst plus a toast:
`IAM Engine — built by Evan Kent, 2026 · see /credits`. Global client key
listener mounted from the layout; ignores keystrokes while focus is in an
input/textarea/contenteditable.

### 7. Console signature
One styled `console.log` on app load (client component, fires once per page
load): a small ASCII mark plus
`Crafted by Evan Kent · 2026. Debugging? Check /docs first.`

### 8. `/credits` page
An **unlinked** route, film-credits styling: created-by credit and fun static
build stats (PRs shipped, runner versions, clients profiled) written as fixed
text at build time — no live queries. Viewable by any logged-in user; the
Konami toast is the breadcrumb that reveals it.

### 9. Logo 7-click
Clicking the header app title 7 times within ~3 seconds plays a single spin
animation and renames the title to **"Evan's IAM Engine"** until the next
navigation. Client wrapper around the existing title element.

### 10. Milestone case sparkle
On case detail pages, when the numeric part of the case number is a multiple
of 1000 (IAM0001000, IAM0002000, …), render a small ✨ beside the number with
tooltip "milestone case". Pure render-time check; no schema change.

### 11. Change log opening crawl (added 2026-07-24, second batch)
On any `/changelog` page (v1/v2/v3 — mounted from the shared `ChangelogView`),
typing **starwars** (case-insensitive, `lib/eggs/starwars.ts` state machine,
konami-egg listener pattern, inputs/textareas ignored) shakes the screen for
~0.75 s, then replaces the view with a full-screen opening crawl: black
starfield, blue "A long time ago in a data center far, far away...." intro,
then the newest 8 changelog entries scrolling in tilted yellow text, closing
with "MAY THE UPTIME BE WITH YOU." **Esc or a click** returns to the page.
`prefers-reduced-motion` skips the shake and renders the crawl as static,
scrollable text. No changelog entry, per the updated policy above.

## Shared confetti component
Eggs 5 and 6 share one dependency-free canvas confetti component
(~60 lines, `web/app/_components/eggs/confetti.tsx`). **No npm package is
added.**

## Error handling
- Egg components are leaf UI; any thrown error must not take down the shell.
  Date parsing is defensive (invalid `simulated_date` cookie → ignored).
- The simulator cookie is ignored for non-super-admins server-side, so a
  crafted cookie from a normal user does nothing.

## Testing
- Unit tests for `occasions.ts`: every birthday branch (weekday/Sat/Sun years,
  e.g. 2026 Sat, 2027 Sun, 2028 Tue), every holiday shift rule (Tue–Fri, Sat,
  Sun, Mon cases), floating-holiday computation, bulb glyph windows, new-year
  window, and "birthday beats holiday-eve" precedence.
- Unit test for `effective-date.ts` gating (cookie honored only for real
  super_admin).
- Manual verification via the simulator itself: set 2026-11-13, 2026-11-14,
  2027-11-14 (Sun) / 2027-11-15, a holiday eve, Dec 24, Jan 1.

## Conventions & shipping
- No changelog entries for eggs (policy updated 2026-07-24: the original
  `Easters Eggs - Have fun!` teaser was removed along with the crawl teaser).
- Committed openly in a normal draft PR — nothing hidden from git history.
- UI follows the flat/minimal design system; banners use existing banner
  styling patterns.

## Out of scope
- No DB migrations, no AppSetting config UI, no runner changes.
- The simulated date does not affect any business logic, reports, or audit
  timestamps — eggs only.
