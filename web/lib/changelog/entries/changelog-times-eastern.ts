import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "changelog-times-eastern",
  date: "2026-07-15",
  time: "17:00",
  title: "Change log times now read in Eastern - and today's entries were corrected",
  items: [
    "The change log had started showing ship times in UTC (a batch of today's entries read '9:30 pm' when it was mid-afternoon Eastern), because the build session's clock is UTC while the team reads in Eastern. Times are shown verbatim, so a UTC stamp displayed as-is looked hours into the future",
    "Every 2026-07-15 entry was re-stamped to its real Eastern ship time (taken from each change's merge time) and the day was put back in true order - newest at the top. Earlier days were already in Eastern and were left as they are",
    "The convention is now explicit in the log itself: both the date and the time are Eastern (America/New_York), rounded down to the quarter hour, so a new entry can never claim a time that has not happened yet",
    "Display and data only - nothing about how updates are sent to the client chat channels changed",
  ],
};
