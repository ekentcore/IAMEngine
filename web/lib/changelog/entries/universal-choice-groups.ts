import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "universal-choice-groups",
  date: "2026-09-25",
  time: "14:00",
  title: "Map a client's ServiceNow Universal Choices straight to Microsoft 365 and Google groups",
  items: [
    "A new Universal choices section on each client's page lists the choices on its ServiceNow onboarding form, grouped by their Question: Cloud Applications, Generic Computer, Installed Software, Shared Drives, Distribution Group, Product License, Role, Security Group and Shared Mailbox",
    "Sync from ServiceNow pulls them in. Syncing again picks up new and renamed choices and never loses a mapping; a choice removed in ServiceNow is marked, not deleted",
    "Type the Microsoft 365 and Google groups a choice should add, one per line. Every hire who picks it gets those groups, with no group rule to write per cloud application",
    "Microsoft 365 groups are added by the Microsoft 365 step (distribution lists go through Exchange, as before) and Google groups by the Google step",
    "A Security Group or Distribution Group choice left unmapped keeps being added by its own name, exactly as today, so nothing changes for a client until someone maps something",
  ],
};
