import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "changelog-one-file-per-entry",
  date: "2026-07-16",
  time: "12:45",
  title: "The change log is now one file per entry — shipping two things at once no longer means a merge conflict every time",
  items: [
    "Every entry lived in one list that each shipping change edited at the same line, so any two changes in flight collided and someone had to untangle them by hand before either could merge. Nobody was doing anything wrong: 11 of the last 25 changes touched that list, and every one of them touched the same line of an 839-line file. Four shipped today, so all four collided",
    "Entries are now separate files. Two changes add two different files, which merge without anyone noticing. The one line they still share is placed alphabetically, so they land far apart — and if they ever do land together, both are kept automatically",
    "The log is sorted by each entry's own date and time instead of by where someone typed it, so it can't drift out of order. That has actually happened: an earlier fix existed to re-order and re-stamp a batch of entries that went in with the wrong times",
    "Nothing about the page, the chat send, or the AI docs draft changes, and no entry text was touched. All 64 entries are byte-for-byte identical. Nine of them swapped places with an entry sharing the exact same timestamp — the page shows both the same time, so there is nothing to tell them apart on screen either way",
    "Adding an entry: create the file, add one line. There is a check that fails the build if the two ever disagree — the same kind of two-lists-must-agree mistake that took Exchange down this morning",
  ],
};
