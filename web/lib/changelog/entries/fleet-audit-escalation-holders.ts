import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-audit-escalation-holders",
  date: "2026-07-22",
  time: "17:15",
  title: "Fleet audits: new 'Extra access' scan shows who HOLDS escalation roles, and audits moved under Tools",
  items: [
    "New 'Extra access' tab on Fleet audits: instead of who's missing a permission, it lists who HOLDS an escalation-capable Graph role — AppRoleAssignment.ReadWrite.All (the tenant-takeover route) sorts first, then the rest, each expandable to the clients whose app registration holds it",
    "It's the inverse of the permissions pivot and read-only/advisory — these roles are surfaced for a security review, never removed automatically",
    "A client whose credential couldn't be read is listed as 'couldn't check' rather than silently counted as holding nothing",
    "Fleet audits moved from the Reference menu into Tools, alongside Fleet setup — M365 (both are fleet-wide M365 tools)",
  ],
};
