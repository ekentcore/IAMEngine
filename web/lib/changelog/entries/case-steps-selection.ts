import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "case-steps-selection",
  date: "2026-09-22",
  time: "19:30",
  title: "Cases: choose which steps run on each case",
  items: [
    "A new \"Steps on this case\" section lists the client's systems for this onboard or offboard with a tick box each. Saving re-plans the case",
    "Tick an On Request step to run it on this case - before, an on-request step only ran if the intake form happened to ask for it, and there was no way to tell the engine it had been requested",
    "Untick a step this case doesn't need (for example an email-only onboard, or a user who shouldn't get Zoom) and it's skipped for this case only; the client's setup is unchanged",
    "Steps that already ran, or that an intake rule skips for the requester, are locked and say why. The choice survives re-imports from ServiceNow and is recorded in the audit log",
  ],
};
