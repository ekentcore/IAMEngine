# Sound eggs — ten new easter eggs, seven with synthesized sound

Date: 2026-07-24 · Status: approved for build (background run; assumptions noted inline)

## Goal

Third egg batch. Evan asked for "sounds — like a 404 page with Shaq wagging his finger going
'no no no' — play out 10 more, include sounds in some." This adds the app's first audio, a
styled 404 page, and ten new eggs following every existing convention (typed-word triggers,
ModeSkin class hooks, catalog + demo coverage, teaser-only changelog entry).

## Sound architecture (no assets, ever)

- `lib/eggs/sounds.ts` — pure data. `EggNote { at, freq, dur, type?, gain?, bendTo? }`,
  `EggNoise { at, dur, gain?, band? }`, `EggSound { notes, noise?, loopDur? }`, and the
  `EGG_SOUNDS` registry. Browser-free so node:test can validate every sequence.
- `app/_components/eggs/egg-audio.ts` — the player. Lazy shared `AudioContext`;
  `playEggSound(sound)` schedules oscillators (exp-decay envelopes, optional pitch bend) and
  white-noise bursts (optional bandpass); `startEggLoop(sound)` returns a stop function.
  Master gain 0.22. Everything try/caught — audio failure can never break an egg.
- Autoplay policy: every sound fires from a user gesture (keydown of a typed word, or a
  click), so the context is always resumable. The 404 page never autoplays; its sound is
  click-to-play.
- Kill switch: `localStorage["egg-sounds"] = "off"` silences all of them (checked per play).
  Documented on /easter-eggs.
- No copyrighted recordings or melodies: everything is original synth gesture in the *spirit*
  of the reference (two low staccato hits, a descending trombone slide, DTMF + noise, etc.).

## The Shaq constraint

A real photo of Shaq + the meme audio can't ship (likeness + copyrighted clip). Repo
convention is asset-free CSS/emoji recreations (Jurassic, HAL, Gandalf), so the 404 page
recreates the vibe originally: bouncing-🏀 zero in "404", a giant wagging finger, "NO. NO.
NO." pulsing word by word, caption "Not in my house — that page doesn't exist." Clicking the
finger plays three "uh-uh-uh" bass thumps + a referee-whistle chirp.

## The ten eggs

| # | slug | where | trigger | sound |
|---|------|-------|---------|-------|
| 1 | `not-found-nope` 🏀 | new `app/not-found.tsx` | visit any missing page | uh-uh-uh + whistle, click-to-play |
| 2 | `law-and-order` 🚔 | /cases | type `lawandorder` | DUN DUN two-note hit on open |
| 3 | `sad-trombone` 🎺 | /runs failed rows | type `womp` | wah-wah-wah-waaah on activate |
| 4 | `dialup-agents` 📞 | /agents | type `dialup` | DTMF dial → carrier → noise screech → connect |
| 5 | `mario-coins` 🪙 | anywhere (layout) | type `mario` | coin b-ding per block bonk |
| 6 | `airhorn-ship` 📣 | /changelog newest entry | type `airhorn` | triple airhorn blast |
| 7 | `clippy` 📎 | anywhere (layout) | type `clippy` | boing on appear; page-aware one-liner |
| 8 | `rickroll` 🕺 | anywhere (layout) | type `rickroll` | deliberately silent — parody lyrics only |
| 9 | `this-is-fine` 🔥 | /runs failed rows | type `thisisfine` | none |
| 10 | `hold-music` 🎼 | case detail waiting steps | type `holdmusic` | soft synth loop until Esc |

Shapes: 2/4 are takeover shows (Esc/click closes, sound stops); 3/6/9/10 are ModeSkin mode
eggs riding class hooks (`gf-err` reused on /runs; new `ah-newest` on the newest changelog
entry; new `hm-wait` on waiting case steps); 5/7/8 are global popups mounted in the layout;
1 is a page. Reduced motion honored everywhere animations exist.

Trigger words checked for prefix interference against every mounted surface — none interact
(each listener tracks its own progress; `mario`/`matrix`, `holdmusic`/`hal` reset cleanly).

## Bookkeeping (enforced by tests)

- `lib/eggs/catalog.ts`: +10 live entries; `catalog.test.ts` counts 24 → 34.
- `EGG_DEMOS`: one demo per egg (demo-coverage.test enforces). Demo clicks are gestures, so
  demo sounds play. Notes mention the sound and the kill switch.
- Changelog: teaser-only entry per egg policy — `sound-eggs.ts`, items `["🥚🔊"]` — plus its
  `_registry.ts` line.
- New test `lib/eggs/sounds.test.ts`: every registered sound has events, positive
  freqs/durations, loops cover their events, and every catalog-declared sound slug exists.

## Out of scope

Volume UI/settings page (localStorage switch only), real audio assets, sounds on existing
eggs, mobile haptics.
