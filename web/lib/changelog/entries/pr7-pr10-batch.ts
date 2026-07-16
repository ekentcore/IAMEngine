import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "pr7-pr10-batch",
  date: "2026-07-09",
  approx: true,
  title: "Licensing, password reset, persona confirm, ServiceNow scan (PRs #7-#10)",
  items: [
    "Group-based license assignment (assign via AD/Entra group, resolved live)",
    "Ad-hoc password reset with a one-time reveal (wiped after viewing)",
    "Persona confirmation flow: hold + suggest when no persona matches a new hire (in review)",
    "'Check ServiceNow' scan marks steps complete from resolved tickets, with lossless undo",
  ],
};
