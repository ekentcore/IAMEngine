import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "db-copy-tool",
  date: "2026-07-23",
  time: "10:30",
  title: "New admin tool: DB copy — clone the database into a second one (POSTGRES_* → POSTGRES_*1)",
  items: [
    "Tools → DB copy (admin only): copies the source database described by POSTGRES_* into the destination described by the same vars with a '1' suffix (POSTGRES_HOST1, POSTGRES_USER1, POSTGRES_DB1, …)",
    "Tables that don't exist in the destination are created at full fidelity (columns, types, indexes, constraints, sequences, defaults via pg_dump); tables that already exist have their data replaced (truncate + reload)",
    "Shows a preview first — source→destination identity and every table with its approximate row count and whether it will be created or replaced — and requires you to type the destination database name to run",
    "The Prisma migration ledger is not copied, and a copy onto the same database is refused; credentials are passed to pg_dump/psql via the environment so passwords never appear in the process list, and the run is written to the audit log",
  ],
};
