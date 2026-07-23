import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "db-copy-connection-form",
  date: "2026-07-23",
  time: "12:30",
  title: "DB copy: fill in the destination in a form and see a step-by-step connection test",
  items: [
    "The DB copy tool now has a destination form (host, port, user, database, schema, password) instead of hand-editing env.env — the non-secret fields are remembered between visits; the password is never stored and is re-typed each time.",
    "Testing a connection now shows a step-by-step probe for both source and destination — config, host reachable, authenticated, database selected, server version, tables counted — so you can see exactly what it's connecting to and where it fails (everything except the password).",
  ],
};
