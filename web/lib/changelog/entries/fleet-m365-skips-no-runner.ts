import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-m365-skips-no-runner",
  date: "2026-07-24",
  time: "12:00",
  title: "New 'No runner' client flag — Fleet M365 setup skips clients with no agent",
  items: [
    "Client page has a new 'No runner' toggle for clients that will never have an agent (e.g. Dianthus) — audited like the other client toggles",
    "Fleet setup — M365 (and the sweep it queues) now excludes flagged clients entirely, so they never queue connection tests that would just sit pending forever with nothing to claim them",
  ],
};
