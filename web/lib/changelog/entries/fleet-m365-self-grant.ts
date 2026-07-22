import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-m365-self-grant",
  date: "2026-07-22",
  time: "16:00",
  title: "Fleet setup — M365: self-grant missing permissions from an over-permission, and tidier rights",
  items: [
    "When a client is missing permissions but its app registration already holds AppRoleAssignment.ReadWrite.All (the 'Extra Access — risk' role), 'Correct permissions' now grants the missing Graph roles using that role — no Global Admin sign-in needed",
    "Over-permissioned roles are still only flagged, never removed — the self-grant only adds the permissions that are missing",
    "Expanding a client no longer lists the same permissions twice: m365 and entra share one app registration, so their identical permission set is shown once (labelled for both); exchange stays separate",
    "Per-client Retest and the 'Not tested yet' state (a client keeps its stored scan on return, action stays disabled until there's a result) — these were part of the fleet tool but didn't make the first cut; they're in now",
    "A stuck sweep (tests queued with no runner online) self-clears instead of freezing the top button on 'Testing…', and a Stop button cancels a sweep on demand",
  ],
};
