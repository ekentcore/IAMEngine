import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "changelog-times",
  date: "2026-07-13",
  time: "23:00",
  title: "Change log: the time it shipped, not just the day",
  items: [
    "Every entry now carries the time of day it shipped, to the quarter hour - on a day with eight ships, the date alone told you nothing about the order",
    "The entries already in the log were backfilled from the commit that introduced each one, so the log now reads in true order; entries from before the log existed stay date-only rather than being given invented times",
    "The time goes out with the entry when you send it to chat, on the same 'Shipped:' line",
    "Two entries were dated a day late (2026-07-14, a UTC slip) and are now dated 2026-07-13, when they actually shipped",
  ],
};
