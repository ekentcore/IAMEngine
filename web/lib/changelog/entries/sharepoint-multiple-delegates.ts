import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "sharepoint-multiple-delegates",
  date: "2026-09-03",
  time: "18:00",
  title: "OneDrive site access now reaches every delegate, not a merged non-existent one",
  items: [
    "When an offboard named several people for the leaver's OneDrive, the SharePoint hand-off ran their names together into one — \"Rachel Thompson Nicole Hayes\" — found nobody by that name, and warned instead of granting. (FR #0000120)",
    "This was a miss in the multiple-delegates work (#0000084): the mailbox and the OneDrive invite were both widened to take a list, and a third place that grants site-collection admin was not. Joining a list into text drops the comma, which is exactly what you saw",
    "Each named person is now granted independently, so one unresolvable or ambiguous name warns about THAT name and everybody else still gets their access",
    "A single delegate behaves exactly as before",
    "The safety rule is unchanged: site-collection admin is high-privilege, so a name matching more than one person is still skipped with a warning rather than guessed at",
    "Runner 1.113.0 (SharePoint module) needs deploy",
  ],
};
