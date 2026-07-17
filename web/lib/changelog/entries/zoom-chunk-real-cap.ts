import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "zoom-chunk-real-cap",
  date: "2026-07-17",
  time: "11:00",
  title: "Fleet report no longer arrives with its tail cut off in Zoom",
  items: [
    "The M365 fleet permission report was split against a 4096-character budget, but Zoom's real cap is 4000 - so every packed-full message silently lost its last lines in the room (the 2026-07-17 report ended mid-list around Wavecrest Management)",
    "Messages are now budgeted at 3800 UTF-8 bytes: under the 4000 cap whether Zoom counts characters or bytes (the report is full of multibyte punctuation, so character counts under-measure)",
    "Verified against the live fleet: the report packs into 3 messages of at most 3718 bytes each, with every client name and the final line intact",
  ],
};
