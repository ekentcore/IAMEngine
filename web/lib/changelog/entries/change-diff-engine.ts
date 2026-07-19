import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-diff-engine",
  date: "2026-07-18",
  time: "17:45",
  title: "Change/mover: access diff engine",
  items: [
    "Added pure diff functions that compute which groups/OU to add vs remove for a mover or ad-hoc change, across scoped/full/add-only removal modes with protected-group exclusion",
    "Internal groundwork on the change-delta contract types—no user-facing behaviour yet",
  ],
};
