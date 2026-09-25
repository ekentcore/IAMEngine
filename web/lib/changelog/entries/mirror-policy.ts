import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mirror-policy",
  date: "2026-09-22",
  time: "20:15",
  title: "Mirroring a user: security groups only, and groups that are never copied (runner 1.134.0)",
  items: [
    "Edit systems now has two mirror settings on Active Directory, Microsoft 365 and Exchange: Mirror security groups only, and Never mirror (group names, with * as a wildcard)",
    "When an onboard says \"mirror <user>\", those settings decide what gets copied - e.g. LogicSource can mirror only security groups and never the ChatGPT group",
    "Anything held back is listed on the step's result with the reason, and the Microsoft 365 check no longer reports held-back groups as missing",
  ],
};
