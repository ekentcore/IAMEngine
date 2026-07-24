import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "reference-docs-v3",
  date: "2026-07-24",
  time: "17:15",
  title: "Reference documents refreshed to version 3.0",
  items: [
    "The four reference documents in /docs (Client Overview, Setup and Configuration, Security Design, Internal Reference) are updated to version 3.0, each version-history table recording what changed since v2.0 (22 July 2026)",
    "Corrected the biggest staleness: dry run is retired — all four documents now describe the staged read-only verification instead, with the reasoning (the -WhatIf mode suppressed real API output and could mislead); and the security design no longer calls the runner token fleet-shared — per-agent tokens, hashed at rest and rotated remotely, are documented in sections 5.2, 10, and 12",
    "Folded in the features shipped since v2.0: the offboard -a admin-account sweep and already-shared-mailbox licence unblock, adopt-only M365 on ad-synced clients, per-client mailbox-audit / calendar-reviewer / additional-groups onboarding config, license-dependency self-heal, named-holder alias collisions, the Delinea subfolder guarantee, optional-permission and not-needed connection-test reporting, and the corrected Egnyte credential",
    "The Internal Reference gains a Fleet operations section covering the Azure-move tooling: Fleet setup — M365, fleet audits, Fleet health with proactive alerts, the go-live preflight, the cutover console, maintenance/drain, the concurrency governor, the runner pool, restore drills and off-box backups, DB copy, and deployment status",
    "Published to the live DB per document via npx tsx scripts/publish-seed-doc.ts --slug <slug> --publish --major; the seed baseline for fresh installs is now 3.0",
  ],
};
