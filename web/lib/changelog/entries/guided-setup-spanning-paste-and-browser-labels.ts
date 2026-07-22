import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "guided-setup-spanning-paste-and-browser-labels",
  date: "2026-07-22",
  time: "13:15",
  title: "Guided setup: Spanning paste path fixed, API/Browser credential labels, browser-login id-only",
  items: [
    "The guided setup's “type it” form now derives + re-keys like the automatic path: for Spanning it shows the email-service + region dropdowns (hiding the “region or base url” text box) and fills apiURL + AccountID automatically — fixing the “missing login email / region or base url” 422 you'd hit pasting a Spanning credential by hand",
    "Every typed credential is now posted keyed by its canonical field synonym (not the human label), so the probe/create shape check and the runner's field-picking agree — vendors whose labels didn't coincidentally match a synonym now save correctly (google-admin's file-seeded key path is unchanged: its labels already are the synonyms)",
    "Each setup step now shows whether a credential is the API key or the console sign-in: “Spanning Backup (API)” vs “Spanning Backup (Browser)” in the title and the rail, so the two Spanning steps are no longer indistinguishable (same for M365 admin vs global-admin)",
    "Browser-login secrets (spanning-portal, m365-global-admin, the *-console logins) are now Delinea-id ONLY in the wizard — paste or pick a reference and Save; no typed username/password create form and no field-shape “Test” button (a console sign-in can't be API-tested), and a saved reference counts as wired",
  ],
};
