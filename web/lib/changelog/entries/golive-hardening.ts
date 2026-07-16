import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "golive-hardening",
  date: "2026-07-12",
  title: "Go-live security hardening (PR #16)",
  items: [
    "Credential broker now requires authentication; client-scope bypass closed",
    "Auth fails closed everywhere (middleware, installers, enrollment) when secrets are missing",
    "Database indexes on the hot job/audit/case paths; ServiceNow write guard; UI overflow fixes",
  ],
};
