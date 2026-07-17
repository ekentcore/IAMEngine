import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "dismiss-warnings-on-a-done-case",
  date: "2026-07-16",
  time: "19:30",
  title: "Done cases: dismiss all the warnings you finished by hand, in one click",
  items: [
    'A case like UM0029777 — automation did most of it, you completed the rest manually — stayed orange forever: warnings could only be ignored one step at a time, and the cases LIST recomputed them raw so it stayed orange even then. (FR #0000013)',
    'A completed (or failed) case with warnings now has a "✓ Dismiss warnings" button on the run report. Every warning step flips to accepted/verified, the matching run-log lines are marked Fixed, and the case stops painting orange on the list too.',
    "Failed steps are NOT swept up — a real failure still needs its own explicit accept.",
    "Self-resurfacing: any new real result on the case clears the dismissal, so fresh problems never hide behind an old \"I finished it by hand\". A ↺ restore link undoes it manually; who dismissed and when is audited.",
    "Migration 20260716190000 needs deploy (dev DB done).",
  ],
};
