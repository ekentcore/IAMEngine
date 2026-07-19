import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-api-routes",
  date: "2026-07-18",
  time: "18:15",
  title: "Change/mover: create/confirm/bulk API routes",
  items: [
    "POST /api/cases/change (create+plan), /api/cases/:id/change/confirm (apply removal mode, gated on case.approve_destructive), and /api/cases/change/bulk (fan one transition across up to 100 users, one case each) — thin routes over the change-service planner",
    "Internal groundwork on the change action's web surface — same guard/scope/audit pattern as the onboard/offboard case routes",
  ],
};
