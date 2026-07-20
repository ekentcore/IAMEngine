import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "case-exit-dry-run",
  date: "2026-07-20",
  time: "11:45",
  title: "Take a dry-run case live in one click",
  items: [
    "A case that already ran in dry-run can be flipped to a real run from the case page (clears dry-run, re-queues the automated steps) instead of needing a re-import/SQL",
  ],
};
