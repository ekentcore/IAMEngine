import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-provision-exchange-app-only",
  date: "2026-07-20",
  time: "15:00",
  title: "M365 auto-setup now grants the app registration Exchange Online app-only rights",
  items: [
    "The provisioner minted + vaulted the Exchange certificate but never granted the other two things EXO app-only needs, so Exchange connection tests failed on the provisioned credential",
    "It now grants Exchange.ManageAsApp (Office 365 Exchange Online, admin-consented) and adds the app's service principal to the Exchange Administrator directory role, alongside the existing Graph grants",
    "Both are best-effort and reported: a tenant where they fail (e.g. the GA lacks RoleManagement.ReadWrite.Directory consent) still finishes the rest of setup, with a WARN saying what to complete by hand; a new exchangeReady flag records success",
    "The app manifest's requiredResourceAccess now declares the Exchange block too (merged, never replacing other resources)",
  ],
};
