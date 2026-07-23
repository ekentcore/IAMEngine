import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "db-copy-build-schema-button",
  date: "2026-07-23",
  time: "15:00",
  title: "DB copy: a Build schema button to set up the destination — no terminal needed",
  items: [
    "The DB copy page now has a Build schema (migrate) button that runs `prisma migrate deploy` against the destination for you — creating its tables, enum types and constraints so you don't have to open a terminal. The full migration is now Test → Build schema → Copy, all in the browser. The destination password is used only for the action and never stored; the migrate output is shown (with passwords scrubbed).",
  ],
};
