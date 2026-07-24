# Pirate egg — the change log as a naval battle

**Date:** 2026-07-24
**Status:** Shipped
**Trigger:** typing `pirate` (any case) anywhere on a `/changelog` page (v1/v2/v3 — mounted
from the shared `ChangelogView`), outside of inputs/textareas/contenteditable.

## What happens

A full-screen overlay (portaled to `<body>`, same reason as the starwars crawl: a transformed
ancestor would otherwise contain the `position: fixed` element) replaces the page with a night
sea: stars, moon, drifting wave bands, and two pirate-ship silhouettes bobbing on opposite
sides. The newest 8 entries are fired between the ships as broadsides, alternating direction.
Each volley: muzzle flash on the firing ship (0.35s) → cannonball arc across the screen
(1.1s) → explosion at the target ship → the entry unfurls on a parchment card, translated to
pirate speech. Volleys advance every 6.5s; after the last one an end card ("That be all th'
plunder, matey ☠️") holds. Esc or a click returns to the page.

## Pieces

- `web/lib/eggs/pirate.ts` — pure and unit-tested (`pirate.test.ts`):
  - `advancePirate` — typed-word state machine, identical shape to `starwars.ts`/`konami.ts`.
  - `piratify(text)` — word-boundary swaps with case preservation (`the → th'`, `is/are → be`,
    `you → ye`, `user → landlubber`, `server → galleon`, `bug → barnacle`, …) plus a
    long-word `-ing → -in'` rule. Deliberately modest so entries stay readable.
  - `pirateFlourish(i)` — deterministic interjection per volley (no `Math.random`, so stable).
- `web/app/changelog/_components/pirate-egg.tsx` — the scene. Pure CSS keyframes, zero new
  dependencies (GSAP was considered and skipped — every egg is dependency-free and the arc is
  just an outer element animating X linearly while the inner animates Y up/down).
- Mounted in `changelog-view.tsx` beside `StarWarsEgg`; the two state machines don't interact
  ("pirate" contains no "s" restart hazard for "starwars" and vice versa is a plain reset).

## Accessibility / conventions

- `prefers-reduced-motion: reduce`: no cannons, no timers, no bobbing — the overlay becomes a
  scrollable static list of the pirate-speech parchment cards.
- Keystrokes in form fields never advance the word (shared `isTypingTarget` predicate).
- Changelog policy (per Evan): teaser-only entry — `Easter Egg - Dead Men Tell No Logs`,
  items `["🥚🏴‍☠️"]`. No hints in the entry.
