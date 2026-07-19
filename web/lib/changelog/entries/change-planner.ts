import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-planner",
  date: "2026-07-18",
  time: "17:45",
  title: "Change/mover: planner (jobs + approval gating)",
  items: [
    "Turns a change diff into per-directory jobs, gates removals/OU-moves behind approval, and injects a directory-sync step after AD",
    "Internal groundwork on the change planning path — no user-facing behaviour yet",
  ],
};
