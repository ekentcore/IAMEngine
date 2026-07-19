import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-ui-components",
  date: "2026-07-18",
  time: "18:45",
  title: "Change/mover: create dialog + preview modal",
  items: [
    "New change-case dialog (clients list): start a mover (persona/location swap) or an ad-hoc access change (groups, distribution lists, AD OU move) for an existing user",
    "New change preview modal (case detail): review the rule-derived per-system add/remove diff and choose scoped, full-reconciliation, or add-only removal before confirming — not yet wired into the clients/cases pages, that's the next change",
  ],
};
