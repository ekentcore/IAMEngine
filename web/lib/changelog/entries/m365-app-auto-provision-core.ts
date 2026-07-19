import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-app-auto-provision-core",
  date: "2026-07-19",
  time: "14:15",
  title: "Groundwork: automated Entra app-registration provisioning (Graph core)",
  items: [
    "New internal `provisionM365App` - given a Global-Admin Graph token it finds or creates the iam-engine app registration, attaches a client secret and certificate, and admin-consents every required plus optional Microsoft Graph app role, idempotently (re-runs reconcile missing grants and keep valid creds)",
    "Not wired to a browser login or any UI yet - this is Graph plumbing only, laying the groundwork for the guided app-registration setup flow in a later phase",
  ],
};
