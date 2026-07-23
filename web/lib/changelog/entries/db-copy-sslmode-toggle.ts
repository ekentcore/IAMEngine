import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "db-copy-sslmode-toggle",
  date: "2026-07-23",
  time: "12:45",
  title: "DB copy: a 'Require SSL' toggle so you can connect to Azure / managed Postgres",
  items: [
    "The DB copy destination form now has a Require SSL (sslmode=require) toggle. Managed Postgres like Azure refuses non-TLS connections (\"no pg_hba.conf entry … SSL off\") — turn this on to connect. It's remembered with the rest of the destination profile and applies to both the connection test and the actual copy (pg_dump/psql via PGSSLMODE).",
  ],
};
