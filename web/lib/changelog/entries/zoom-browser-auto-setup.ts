import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "zoom-browser-auto-setup",
  date: "2026-07-22",
  time: "07:00",
  title: "Zoom: automatic browser setup — create the API app and vault it",
  items: [
    "The guided Zoom setup gains an “Automatic (browser)” tab: the runner signs into the Zoom App Marketplace with a zoom-console admin login, creates the “iam-engine” Server-to-Server OAuth app, harvests its Account ID / Client ID / Client Secret, and vaults the zoom credential to the client's Vendor subfolder in Delinea (wired + recorded in setup provenance)",
    "Only shows for clients that have the Zoom system; the harvested secret is scrubbed from the job result once vaulted",
    "Runner 1.84.0 — needs deploy. Browser selectors are best-effort and NEED LIVE VALIDATION against a real Zoom console; a Zoom account behind org SSO can't use a password login — paste the credential instead",
  ],
};
