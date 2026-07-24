import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "db-copy-compare-button",
  date: "2026-07-23",
  time: "21:15",
  title: "DB copy: a Compare button to verify a copy (per-table row counts, source vs destination)",
  items: [
    "The DB copy page has a new Compare tables button — a read-only check that lists every table with its exact row count on the source and on the destination side by side, flags any that differ, and says whether they all match. Handy for confirming a copy actually landed. It uses real count(*) numbers (not the estimates that read 0 right after a restore), and excludes the Prisma migration ledger.",
  ],
};
