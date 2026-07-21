import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mailbox-size-decision-clarity",
  date: "2026-07-21",
  time: "12:15",
  title: "Offboard mailbox decision: says why Convert is missing, and stops mis-reading a readable size as \"unknown\"",
  items: [
    "The over-50 GB decision (keep the licence / remove it) now states plainly, next to the two buttons, that converting to a shared mailbox isn't an option because the mailbox is over the cap — the under-cap decision offers Convert, so its absence was leaving people guessing why",
    "Root cause of a 33 MB mailbox (UM0029906) reporting \"size couldn't be read\" and hiding Convert: the Exchange step DID read the size and DID convert, but its result was posted as a leaked array ([null, {…}]) — so the licence step saw no size and no conversion and asked a question already answered. Job results are now unwrapped to their envelope before anything reads or stores them, and old array-shaped rows still render correctly",
    "The mailbox-size read (FR #20) is now tolerant of every shape TotalItemSize arrives in — the structured .Value.ToBytes(), the \"(…,… bytes)\" string, and a bare unit-suffixed \"33.5 MB\" with no byte count (a deserialized remote session, the shape that read as unknown) — while a genuinely unreadable size still comes back unknown, never 0",
    "Runner 1.81.0 (Exchange module) needs deploy for the size-read fallback; the web-side unwrap and the picker note are live on merge",
  ],
};
