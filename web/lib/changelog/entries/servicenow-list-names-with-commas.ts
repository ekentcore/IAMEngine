import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "servicenow-list-names-with-commas",
  date: "2026-09-24",
  time: "10:00",
  title: "A group whose name contains a comma is read as one group, not two (FR #174)",
  items: [
    "ServiceNow sends a multi-select field's names joined with commas, so a distribution list called \"Sales, East\" came through as two groups, \"Sales\" and \"East\"",
    "The engine now counts the entries ServiceNow actually selected. One entry is always read as one name, commas and all. When several are selected and a name contains a comma, it looks the names up in ServiceNow by record instead",
    "If ServiceNow won't allow that lookup, the case is held with a fill-in for that list rather than adding the wrong groups. Enter the names separated by semicolons (Sales, East; Finance) - the same works in Additional groups",
    "Applies to security groups, distribution groups, shared mailboxes, file shares, cloud applications and product licenses",
  ],
};
