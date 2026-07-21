import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "guided-api-setup",
  date: "2026-07-20",
  time: "21:15",
  title: "Guided API setup for Mimecast, Spanning, and Proofpoint",
  items: [
    "Each client's Actions menu now offers a 'Setup <system> API' item — shown only for the systems that client actually has — that walks you through creating the vendor API app, then verifies the credential by connecting to the vendor live before it is vaulted",
    "Verification is a real connection: Mimecast runs the 2.0 OAuth client-credentials grant, Spanning authenticates to the Backup API, and Proofpoint Essentials signs in with the admin credential — a credential that does not authenticate is refused rather than silently saved",
    "Proofpoint setup captures the data region (us1–us5, eu1, au1); both the app's live check and the runner now use it, so non-us1 orgs no longer need the region hand-edited into Delinea",
    "Each setup item appears only for the systems a client actually has, and the 'Set up M365 automatically' item now shows only for M365/Entra/Exchange clients — the Actions menu no longer offers setup for systems that don't apply",
    "You can paste the freshly created app's fields to create the Delinea secret, or point setup at an existing Delinea id to verify and wire it — either way the credential is checked before it is saved",
  ],
};
