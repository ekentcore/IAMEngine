import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "db-copy-cross-version-guc",
  date: "2026-07-23",
  time: "14:15",
  title: "DB copy: works when the destination Postgres is older than the source; password show/hide",
  items: [
    "Fixed a copy failure when the destination Postgres is an older major version than the source (e.g. copying a v17 source into a pre-v17 Azure database). pg_dump writes a `SET transaction_timeout` line (a v17 setting) that older servers reject with \"unrecognized configuration parameter\"; the copy now strips that incompatible line from the stream so the load completes.",
    "Added a show/hide (eye) button to the destination password field on the DB copy page.",
  ],
};
