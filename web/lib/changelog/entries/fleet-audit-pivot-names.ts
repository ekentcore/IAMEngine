import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-audit-pivot-names",
  date: "2026-07-19",
  time: "22:00",
  title: "Fleet-audit page: missing-permission clients listed by name, one per line",
  items: [
    "The fleet-audit page's per-permission breakdown (expand a missing permission to see who needs it) showed each client as its CoreID slug with the real name only on hover, all crammed into one wrapping row - unreadable once a permission was missing on many clients",
    "Each affected client now appears on its own line, shown by the client's actual NAME (the CoreID slug moves to the hover tooltip), falling back to the slug when a client has no name on file",
    "Completes the earlier fleet-audit legibility pass, which had only covered the CLI and the page's unverified/no-credential notes, not this in-page permission pivot",
  ],
};
