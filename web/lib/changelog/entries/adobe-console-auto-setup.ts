import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "adobe-console-auto-setup",
  date: "2026-07-22",
  time: "07:15",
  title: "Adobe: automatic (browser) API-credential setup",
  items: [
    "The guided Adobe setup gains an “Automatic (browser)” path: sign into the Adobe Developer Console with an adobe-console admin login and the runner creates the User Management API OAuth Server-to-Server credential, harvests the Client ID / Client Secret / Org ID, and vaults them to Delinea (Vendor subfolder) — no copy-paste",
    "The harvested secret is recorded once, wired onto the client, tracked in the setup-provenance table, and scrubbed from the job result immediately; the raw value is never logged",
    "Runner 1.85.0 — needs deploy. NEEDS LIVE SELECTOR VALIDATION: the Adobe login + Developer Console DOM (create project → Add User Management API → OAuth Server-to-Server → harvest) are best-effort and unverified against a live account",
    "The paste/existing-Delinea-id vault path (from the module-setup foundation) still works for Adobe if you'd rather enter the credential by hand",
  ],
};
