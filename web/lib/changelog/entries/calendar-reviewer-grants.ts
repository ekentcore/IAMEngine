import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "calendar-reviewer-grants",
  date: "2026-07-24",
  time: "14:15",
  title: "Onboarding: per-client fixed calendar reviewers, granted automatically",
  items: [
    "Logicsource's runbook documents a standing calendar delegate — calendar.delegate.reviewer@logicsource.com gets Reviewer on every new hire's calendar — previously a manual step done by hand on every onboard. (FR #0000033)",
    "The Exchange finish step can now apply it automatically: a per-client calendar.reviewers config ([{ user, accessRights }]) runs alongside the mailbox-audit and DL/shared-mailbox work, over the same Exchange Online connection (m365 lane) or the same on-prem/hybrid session (exchange lane).",
    "Config is data, never runnable text — accessRights is checked case-insensitively against the real EXO calendar-folder permission enum (Reviewer, Editor, Author, Contributor, NonEditingAuthor, PublishingAuthor, PublishingEditor, AvailabilityOnly, LimitedDetails); anything else falls back to Reviewer with a warning.",
    "Idempotent: a reviewer who already holds the requested right on a calendar is skipped, not re-granted.",
    "Runner 1.99.0 — takes effect with the next runner deploy; rolling out for Logicsource (core1748) separately.",
  ],
};
