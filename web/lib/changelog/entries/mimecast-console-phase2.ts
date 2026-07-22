import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mimecast-console-phase2",
  date: "2026-07-21",
  time: "22:30",
  title: "Mimecast auto-setup Phase 2: create the API app in the console and vault it",
  items: [
    "The Mimecast guided setup's Automatic (browser) tab gains “Create API app & vault”: after a green sign-in test, the runner drives the Mimecast console to create the “iam-engine” API 2.0 application (Basic Administrator + Account/Domain/User & Group Management), generates the credential, and harvests the Client ID/Secret",
    "The app vaults the harvested credential to Delinea (into the client's Vendor subfolder, via the P0a setup framework), wires it, and records setup provenance — the raw secret is scrubbed from the job result immediately after vaulting",
    "Runner 1.84.0 — needs deploy. The console create-app selectors are best-effort and NEED LIVE VALIDATION against a real Mimecast Administration Console",
  ],
};
