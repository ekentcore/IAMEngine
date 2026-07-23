import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-m365-count-fix-selfcorrect-filter",
  date: "2026-07-22",
  time: "22:45",
  title: "Fleet setup — M365: fix doubled over-permissioned counts, add a 'Can self-correct' filter",
  items: [
    "Fixed the over-permissioned / extra-access count: m365 and entra share one app registration, so their identical permissions were being counted twice — a client with 3 extra roles read as 6. Counts (surplus, escalation, missing) are now per unique permission, so the number matches what's in the expanded list",
    "New 'Can self-correct' filter chip at the top: the clients that hold AppRoleAssignment.ReadWrite.All AND are missing something — i.e. exactly the ones the self-grant button will act on — so you can see at a glance who can fix themselves with no Global Admin",
  ],
};
