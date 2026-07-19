import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-google-lane",
  date: "2026-07-18",
  time: "18:45",
  title: "Change/mover: Google Workspace change executor",
  items: [
    "New Google Workspace change executor: add/remove group membership by name, plus a full reconcile mode (removeGroups vs reconcileGroups+desiredGroups) — the last of the four directory change lanes (AD, M365, Exchange, Google)",
    "Follows the same audit-integrity pattern as the AD/M365/Exchange change lanes: a real add/remove failure logs a WARN, an already-a-member add or not-a-member remove is a benign skip, never a false success line",
  ],
};
