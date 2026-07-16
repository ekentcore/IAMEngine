import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "systems-editor-kb",
  date: "2026-06-12",
  approx: true,
  title: "Systems editor + runbook parsing (week of Jun 8)",
  items: [
    "Systems editor: model each client's runbook as data (lanes, approvals, secrets, config)",
    "KB article parsing (heuristic + AI hybrid) drafted systems for 141 clients",
    "Runner job claim/result/credential APIs with server-side approval gating; agents UI",
  ],
};
