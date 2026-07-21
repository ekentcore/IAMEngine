import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "changelog-times-eastern-utc-fix",
  date: "2026-07-21",
  time: "13:15",
  title: "Changelog: three entries were stamped in UTC, not Eastern — corrected to the right wall-clock time",
  items: [
    "Three of today's entries showed times up to four hours ahead (14:45 / 16:00 / 16:15) — they were captured in UTC instead of America/New_York, so on a 1 pm Eastern day they read as the future",
    "Corrected to Eastern, each matching when it actually shipped: google-key-converter 14:45→10:45, google-oauth-error-names-the-block 16:00→12:00, google-setup-reopen-form-after-failure 16:15→12:15",
    "Reminder for authors: the entry `time` must come from `TZ=America/New_York date +%H:%M` on a 15-minute boundary — never a bare `date` (that's UTC on this box)",
  ],
};
