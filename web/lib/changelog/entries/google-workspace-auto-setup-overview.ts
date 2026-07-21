import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-workspace-auto-setup-overview",
  date: "2026-07-21",
  time: "05:45",
  title: "Set up Google Workspace automatically — one click provisions a client's service account and vaults its credential",
  items: [
    "WHAT IT DOES: from a client's Actions ▾ menu, 'Set up Google Workspace automatically' creates a GCP service account for the client, grants it domain-wide delegation, and vaults a complete, ready-to-use credential in Delinea — replacing the manual chore of creating a GCP project, a service account + key, enabling the Admin SDK, and hand-configuring DWD in the Workspace admin console.",
    "HOW IT WORKS: you provide only the Delinea secret id of a Workspace super-admin login (used transiently for the sign-in, never stored on the client). A runner browser does the super-admin OAuth sign-in; the app then talks to the Google Cloud APIs to find-or-create the project and service account and issue a key; a second, narrow runner-browser step grants domain-wide delegation in the admin console. The complete credential (service-account key material, client email, impersonated admin, customer id) is written to the client's Identity Services subfolder in Delinea on the stock Automation - API template, wired as the google-admin secret and surfaced with its id + a Copy button.",
    "THE MODAL: a centered dialog with a live 5-step tracker (Sign in to Google → Create the service account → Grant domain-wide delegation → Save the credential to Delinea → Test the connection). If the DWD grant can't be confirmed automatically, the run still finishes (status needs_action) with a manual-grant fallback card — paste the service account's client id + scopes into the admin console by hand, then Verify again re-checks with the same inputs, idempotently.",
    "On completion the connection test kicks off automatically against the freshly-wired credential, so a green/red verdict is waiting by the time you check back rather than a separate manual step.",
    "Ships in runner 1.79.0.",
  ],
};
