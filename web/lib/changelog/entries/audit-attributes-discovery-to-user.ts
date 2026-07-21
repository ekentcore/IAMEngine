import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "audit-attributes-discovery-to-user",
  date: "2026-07-21",
  time: "17:30",
  title: "Audit: agent-run client discovery is attributed to the user who kicked it off",
  items: [
    "When a user clicked “Refresh AD objects” or “Refresh cloud groups”, the runner posted the result back and the audit log recorded it as “agent:<id>” — so it looked like the agent changed the client, not the person",
    "The requesting user is now stamped at request time and carried onto the result audit (AD objects, cloud groups, and cloud mailboxes), so those rows show the actual user; the agent id is kept in the row detail for traceability",
    "Creating, archiving, and editing clients already recorded the user correctly — this closes the remaining runner-result gap",
  ],
};
