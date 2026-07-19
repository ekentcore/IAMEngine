import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-audit-names-newlines",
  date: "2026-07-19",
  time: "16:45",
  title: "Fleet-audit CLI lists clients one per line, by name",
  items: [
    "audit-m365-graph-perms.ts printed the clients affected by a missing/over-permissioned/unverified permission as one comma-joined console.log line - a long fleet list clipped off the terminal, same failure class as the Zoom report before it was budgeted",
    "Each affected client now prints on its own indented line, for the missing-permission pivot, the over-permissioned/escalation section, and the unverified list",
    "All three spots (plus the fleet-audit web UI's unverified/no-credential notes) now show the client's NAME instead of its CoreID slug, falling back to the slug when a client has no name on file",
    "byEscalation now accumulates { slug, client } pairs instead of bare slugs so the escalation print site can show names",
  ],
};
