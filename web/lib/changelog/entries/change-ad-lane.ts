import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-ad-lane",
  date: "2026-07-18",
  time: "18:15",
  title: "Change/mover: Active Directory change executor",
  items: [
    "Runner now dispatches change-action jobs to a system's Change lane (falls back to a manual 'no change lane' skip when a system has no Change executor)",
    "New AD change executor: add/remove groups by name, full reconcile to a desired group set (protected groups + Domain Users always kept), OU move, and directory attribute updates",
  ],
};
