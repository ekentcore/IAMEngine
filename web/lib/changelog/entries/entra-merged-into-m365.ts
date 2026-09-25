import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "entra-merged-into-m365",
  date: "2026-09-23",
  time: "09:30",
  title: "Microsoft 365 and Entra run as one step",
  items: [
    "When a client has both Microsoft 365 and Entra on an onboard or offboard, and both are set the same way (both automated, or both manual), the case now has one Microsoft 365 step doing both jobs' work - they were the same code, so every such offboard blocked sign-in, revoked sessions and removed groups twice",
    "Both systems' settings are kept: the merged step gets all of them (Microsoft 365's wins where they disagree), and any approval, evidence snapshot or destructive setting on either side still applies",
    "If one is automated and the other manual, they stay two separate steps exactly as before, so nothing a person was meant to do by hand starts running on its own",
    "The merged step waits on everything either system waited on, except a step that itself has to wait for Microsoft 365 or Entra - that step now simply runs after the merged one",
    "A licence either system left for the other one to remove is now removed by the merged step - it still runs only after Exchange has converted the mailbox",
    "Entra is no longer offered when adding a system; clients that only have Entra keep it and are unchanged, and cases already planned keep their steps",
  ],
};
