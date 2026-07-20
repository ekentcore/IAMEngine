import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "cases-empty-m365autosetup-json-filter",
  date: "2026-07-20",
  time: "11:30",
  title: "Fixed: the cases list showed no cases at all",
  items: [
    "Yesterday's M365 auto-setup change added a filter meant to hide one synthetic behind-the-scenes case from the queue - but it accidentally hid EVERY case, so /cases looked empty for everyone (completed cases still showed on the v2 view; open ones vanished)",
    "The cause was a JSON-filter quirk: 'exclude cases whose marker is set' also drops every case that has no marker at all (almost all of them), because the database treats a missing marker as neither-true-nor-false rather than 'keep it'",
    "The filter now explicitly keeps cases with no marker, so the full queue is back; the same broken filter was also silently making 'Re-plan all cases for a client' a no-op, and that's fixed too",
    "Both call sites now share one corrected filter (with a regression test), so this can't quietly come back the next time someone reuses it",
  ],
};
