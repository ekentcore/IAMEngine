// The build change log shown on /changelog (global admins and above) and shareable to the
// configured chat channels.
//
// TO ADD AN ENTRY when a feature/fix ships:
//   1. create ./<your-id>.ts exporting `entry` (copy any neighbour — they're all the same shape)
//   2. add ONE line to ./_registry.ts, in id order
// That's it. Nothing is hand-ordered: the log is sorted here, by the entry's own date + time.
//
// Why one file per entry. This used to be a single array that every shipping PR edited at the same
// line — 11 of 25 recent PRs touched it, every one of them at line ~45 of an 839-line file — so any
// two concurrent PRs conflicted, every time, and someone had to hand-resolve before merge. Two PRs
// now add two DIFFERENT files, and the one shared line each adds to _registry.ts is placed by id,
// so they land far apart and git merges them silently.
//
// Bullets are sent to chat verbatim as plain text: one line each, no markdown.
import * as registry from "./_registry";
import type { ChangelogEntry } from "../format";

export type { ChangelogEntry } from "../format";
export { isQuarterHour, formatChangelogTime, formatChangelogWhen } from "../format";

// Newest first. The key matches entries.test.ts exactly: a timeless entry (everything before
// 2026-07-13, when `time` became required) sorts to 00:00 of its day, i.e. BELOW that day's timed
// entries — which is where the backfill left them.
//
// The `id` tiebreak is what makes this deterministic. It is not decoration: ~23 entries share an
// identical date+time, because `time` is rounded down to a quarter-hour and several things ship in
// one. The old array survived that on JS sort stability — ties kept their hand-written positions.
// Assembled from a registry there are no hand-written positions to keep, so without a tiebreak the
// order of tied entries would be whatever the module graph happened to produce. Tied entries render
// the same timestamp, so which of them comes first is not information the page can convey anyway.
const when = (e: ChangelogEntry) => `${e.date} ${e.time ?? "00:00"}`;

export const CHANGELOG: ChangelogEntry[] = Object.values(registry)
  .sort((a, b) => when(b).localeCompare(when(a)) || b.id.localeCompare(a.id));
