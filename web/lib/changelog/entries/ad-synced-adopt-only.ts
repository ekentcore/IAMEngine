import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-synced-adopt-only",
  date: "2026-07-22",
  time: "16:15",
  title: "AD-synced clients no longer create M365 accounts by mistake — the account must come from AD",
  items: [
    "For an AD-synced client, an onboarding's M365/Entra step now ADOPTS the account that syncs up from on-prem Active Directory and never creates a cloud one — so a wrong on-prem email/UPN can no longer make 365 quietly create a duplicate cloud account",
    "When the expected account isn't found, the step searches for a synced user with the same name: if one exists under a different sign-in name it pauses the case with a 'Decision needed' picker showing the found vs expected address (usually a wrong AD email to fix and re-sync); if none exists it fails clearly with 'did NOT create in cloud'",
    "If a particular hire really does need a cloud-created account, an operator can allow it for that one case (the picker's 'Allow cloud account for this case & re-run'), or a client can be set to always allow creation via allowCloudCreate on its M365/Entra config",
    "Non-AD-synced clients (e.g. cloud-only Entra) are unchanged — they create accounts exactly as before",
  ],
};
