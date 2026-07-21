import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-automatically-overview",
  date: "2026-07-20",
  time: "18:45",
  title: "Set up M365 automatically — one click provisions a client's Entra app registration and vaults its credential",
  items: [
    "WHAT IT DOES: from a client's Actions ▾ menu, 'Set up M365 automatically' creates and configures that client's iam-engine Entra app registration end to end and vaults a complete, ready-to-use credential in Delinea — replacing the manual chore of registering an app, granting + admin-consenting each permission, generating a certificate, and hand-entering everything into the vault.",
    "WHAT IT SETS UP: the required Graph permissions (create/update users, group membership, read licences/SKUs) plus whichever optional ones you tick (remove MFA / issue a TAP, read verified domains, read mailbox-conversion state, reset a cloud password, app-secret expiry, send-as mail, disable devices, OneDrive delegate); Exchange Online app-only rights (Exchange.ManageAsApp + the Exchange Administrator role); and a client secret + certificate. All are admin-consented in the tenant during the run.",
    "HOW IT WORKS: you provide only the Delinea secret id of a Global Admin login (used once for the sign-in, never stored on the client). A runner browser does the device-code Global-Admin sign-in; the app then talks to Graph to find-or-create the app registration, reconcile permissions, grant Exchange, and issue the secret + certificate as one unit; finally it writes the complete credential (app id, client secret, tenant, certificate base64 + password + thumbprint) to the client's Identity Services subfolder in Delinea, wired as the m365-admin secret and surfaced with its id + a Copy button.",
    "THE MODAL: a centered dialog with a live step tracker (Connect → Sign in as Global Admin → Configure the app registration → Save the credential to Delinea). The sign-in step shows a prominent 'approve the sign-in' callout with the device code + an Open-devicelogin button (the sign-in blocks on a human approving MFA). On completion it shows the vaulted Delinea id, the Exchange grant result, and any optional permission that couldn't be granted (with the reason).",
    "RE-RUNS & REPAIR: an optional-permission picker lets you choose exactly what to grant; 'Set up again' re-runs a completed client; 'Rotate credentials' forces a fresh secret + certificate; and a half-vaulted credential (secret present, certificate never written) self-heals on the next run. Runs are idempotent — re-running a healthy client changes nothing.",
    "The permission a client's app needs, the connection test's capability check (runner), and this setup flow all read the SAME capability table, kept in parity by a guard test — so what setup grants is exactly what the test verifies.",
  ],
};
