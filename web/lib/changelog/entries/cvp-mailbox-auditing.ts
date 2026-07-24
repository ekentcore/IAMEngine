import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "cvp-mailbox-auditing",
  date: "2026-07-24",
  time: "14:00",
  title: "Onboarding: apply the CVP-documented mailbox-auditing settings automatically",
  items: [
    "Community Veterinary Partners' runbook documents a Set-Mailbox -AuditEnabled command with specific AuditAdmin / AuditDelegate / AuditOwner action lists — previously a manual step, done by hand on every new hire. (FR #0000034)",
    "The m365 onboard lane can now apply it automatically: a per-client mailboxAudit config ({ enabled, auditAdmin, auditDelegate, auditOwner }) runs through the Exchange finish step alongside the DL/shared-mailbox work, over the same Exchange Online connection.",
    "Config is data, never runnable text — every action name is checked case-insensitively against the real EXO audit-action allowlist; anything not on it is dropped with a warning, and a list that ends up empty after filtering skips the whole call rather than silently applying a smaller policy than requested.",
    "Runner 1.98.0 — takes effect with the next runner deploy; rolling out for the CVP family (core802 and its 27 inheriting children) separately.",
  ],
};
