# March 22 anniversary egg — design

**Date:** 2026-07-24 · **Status:** shipped with this PR

## What

Every March 22, the first time a logged-in person loads a page that day, confetti bursts and a
full-screen card shows the wedding photo with a big **"Whoo Hoo!"**. Fires once per person per
year; Esc or click dismisses it.

## Decisions

- **Trigger seam:** `occasionsFor(date)` gains `anniversary: boolean` (true on 3/22). Riding the
  existing occasion state means the super-admin date simulator previews it for free, and the
  simulated-date isolation guarantees hold unchanged — nothing new reads the cookie.
- **"On login" = first page view that day**, matching the New Year egg: a per-year
  `localStorage` key (`iam-eggs-anniversary-<year>`) guards it, since the app has no client-side
  login event and the once-per-year guard is what actually matters.
- **Component shape:** `AnniversaryShow` (portal overlay: confetti on mount + photo card,
  click closes) is exported separately from `AnniversaryEgg` (localStorage guard + Escape),
  so the `/easter-eggs` takeover demo mounts the real show without spending the yearly guard —
  the Jurassic pattern.
- **Photo asset:** `data/` is gitignored, so a 1600px `sips` downscale of `data/wedding.jpg`
  (1.1 MB → 433 KB) ships at `web/public/eggs/wedding.jpg`. Note: `public/` assets are served
  statically, so the photo is reachable without a session by anyone who knows the URL —
  accepted for an internal tool; move behind an authed route if that ever changes.
- **Catalog/demo/changelog policy:** live catalog entry (`anniversary-wedding`, counts 24→25),
  `EGG_DEMOS` takeover entry (coverage test enforces), teaser-only 🥚 changelog entry.
- **Reduced motion:** the "Whoo Hoo!" pop animation is gated behind
  `prefers-reduced-motion: no-preference`; confetti parity with the New Year egg (ungated).
