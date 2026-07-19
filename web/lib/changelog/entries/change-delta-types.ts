import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-delta-types",
  date: "2026-07-18",
  time: "17:30",
  title: "Change/mover: access-delta contract types",
  items: [
    "Defined the internal TypeScript contract for change-action access deltas: `ChangePayload`, `ChangeDelta`, `ChangeDiff`, and `ChangeJobConfig` types, plus `DIRECTORY_SYSTEMS` and `PROTECTED_GROUPS` registries",
    "Foundation for the diff engine and runner lane—no user-facing behaviour yet",
  ],
};
