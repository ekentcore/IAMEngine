import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "audit-full-detail-expand",
  date: "2026-07-23",
  time: "21:00",
  title: "Audit log: expand a row to read and copy the full detail (e.g. a long error)",
  items: [
    "Audit log rows with long detail (like a failed job's full error) used to be truncated with the rest only in a hover tooltip you couldn't copy. Each such row is now an expandable disclosure — click it to reveal the full text as selectable content you can copy.",
  ],
};
