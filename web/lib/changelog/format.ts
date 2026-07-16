// The shape of a change-log entry, and the one place a ship time is rendered.
//
// The entries themselves live ONE PER FILE in ./entries/ — see ./entries/index.ts for how to add
// one. They used to be a single hand-ordered array in entries.ts, which every shipping PR edited at
// the same line, so any two concurrent PRs conflicted (11 of 25 recent PRs touched it; every one at
// line ~45). This module is the client-safe half: the type and the formatters, no data.
export type ChangelogEntry = {
  id: string; // stable slug — the send API references entries by id
  date: string; // ISO date (YYYY-MM-DD, EASTERN) the work shipped; append "~" nowhere — use `approx` instead
  // EASTERN (America/New_York) wall-clock ship time, HH:MM on a 15-minute boundary (:00/:15/:30/:45)
  // — round DOWN to the quarter it landed in, so the log never claims a time that hasn't happened yet.
  // The team and the app read in Eastern; the string is rendered verbatim (never zone-shifted), so it
  // MUST be Eastern. The build session clock is UTC — do NOT stamp session time. Get the value with
  //   `TZ=America/New_York date +%H:%M`  (or read the PR's merge time and convert to Eastern).
  // Both `date` and `time` are Eastern. Required on anything shipped from 2026-07-13 on; the older
  // entries below that line predate the field.
  time?: string;
  approx?: boolean; // true when the date is a best-effort reconstruction
  title: string;
  items: string[];
};

const QUARTER_HOUR = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export function isQuarterHour(time: string): boolean {
  return QUARTER_HOUR.test(time);
}

// "22:45" -> "10:45 pm". A wall-clock string, never parsed as an instant, so it can't shift by a
// time zone between the server that renders it and the browser that reads it. A malformed time is
// echoed back verbatim rather than formatted: the tests reject one, but this string also goes out
// to the customer chat channels, and a visible "16:3o" beats a confident "4:NaN pm".
export function formatChangelogTime(time: string): string {
  if (!isQuarterHour(time)) return time;
  const [h, m] = time.split(":");
  const hour = Number(h);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m} ${hour < 12 ? "am" : "pm"}`;
}

// The one place "when did this ship" is rendered — the page and the chat message both call this, so
// the two can't drift. Plain ASCII: the chat channels take it verbatim.
export function formatChangelogWhen(entry: ChangelogEntry): string {
  const when = entry.time ? `${entry.date} ${formatChangelogTime(entry.time)}` : entry.date;
  return entry.approx ? `${when} (approx.)` : when;
}
