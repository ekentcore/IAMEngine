import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "directory-sync-adds-runbook-step",
  date: "2026-07-22",
  time: "23:30",
  title: "Adding directory-sync now also writes the runbook step, not just the system",
  items: [
    "The 'Add directory-sync' button used to add only the ClientSystem row — so directory-sync showed in the readiness chart and ran on cases, but never appeared as a step in the runbook (the runbook is a separate persisted table)",
    "It now goes through one atomic endpoint that adds the system, optionally sets the backbone to ad-synced, AND inserts a directory-sync section into both the onboard and offboard runbook",
    "The section lands right after Active Directory (before the cloud steps) and inherits that lane's KB article; every existing section keeps its steps/attachments and just shifts order to make room",
    "Backfilled 10 clients that already had a directory-sync system but were missing the runbook step (including Estreich & Company / core536)",
  ],
};
