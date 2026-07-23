import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "db-copy-data-only-into-migrated-schema",
  date: "2026-07-23",
  time: "14:45",
  title: "DB copy now loads data into a Prisma-built schema (works on Azure / managed Postgres)",
  items: [
    "DB copy no longer tries to recreate the schema on the destination — which kept hitting managed-Postgres limits (schema/type ownership, superuser-only triggers). Instead you build the destination schema with `prisma migrate deploy`, and the tool copies data only: it checks the destination already has the tables, clears them, and loads the source data. This works on Azure with a normal admin login.",
    "If the destination is missing tables, the tool now says so clearly and tells you to run `prisma migrate deploy` first, instead of failing mid-copy.",
  ],
};
