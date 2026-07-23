import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "db-copy-full-clone-and-audit",
  date: "2026-07-23",
  time: "14:30",
  title: "DB copy now clones the whole database (fixes missing enum types) and audits every attempt",
  items: [
    "DB copy now clones the entire source database in one pass — types (enums), tables, sequences, constraints and data — instead of copying tables one by one. This fixes failures like 'type \"public.AgentScope\" does not exist': the old per-table copy didn't bring the enum types the tables depend on. Re-runs are safe (drop + recreate).",
    "Every copy attempt is now written to the audit log: successful copies (who ran it and source → destination) and failures (who, source → destination, and the reason — with passwords scrubbed).",
  ],
};
