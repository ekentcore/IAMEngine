import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-distribution-lists-lookup",
  date: "2026-09-24",
  time: "15:00",
  title: "Offboarding finds the user's distribution lists directly instead of checking every list (runner 1.142.0, FR #176)",
  items: [
    "The Exchange offboard step used to read every distribution list in the tenant and then each list's members to find the leaver - on a large tenant, minutes of a step that looked stuck",
    "It now asks Microsoft 365 for the user's own group memberships in one lookup and removes them from the cloud distribution lists and mail-enabled security groups found there",
    "If Microsoft Graph can't answer, Exchange is asked for the same list with one filtered query - never the old list-by-list scan",
    "On-premises-synced lists are still left to the Active Directory step, dynamic lists are skipped (their membership follows a rule), and Microsoft 365 groups and security groups are still removed by the Microsoft 365 step",
    "If neither source can list the groups, the step warns that the user may still be in some, instead of reporting none",
  ],
};
