import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "unmodeled-steps-become-manual",
  date: "2026-09-01",
  time: "10:00",
  title: "Runbook steps we haven't automated now appear on the case as manual work",
  items: [
    "A runbook section the engine hasn't modelled as a system — Dropsuite, Box, Verizon, LogMeIn, SalesForce, Visual Studio Subscriptions — used to vanish off the case entirely. It now appears as a manual step carrying the runbook's own instructions, so the Run Report is the whole checklist. (FR #0000096)",
    "The step holds the case open until you tick it off, the same as any other manual step, and un-ticking works if you tick one by mistake",
    "The sections were always being read and classified correctly — they were just never handed to the planner, so nothing downstream ever knew about them",
    "241 of these exist across 134 client-and-action pairs, so most cases gain one step and a few gain several; the worst is ten. They were always work someone had to do, just not written down anywhere the case could see it",
    "Re-planning a case keeps the ones you have already ticked off",
    "Web-only — no runner change",
  ],
};
