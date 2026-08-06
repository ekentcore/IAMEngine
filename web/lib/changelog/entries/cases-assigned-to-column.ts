import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "cases-assigned-to-column",
  date: "2026-08-06",
  time: "17:00",
  title: "Cases: an \"Assigned to\" column showing who opened each case",
  items: [
    "The Cases page now has a sortable \"Assigned to\" column — the operator who opened or imported the case — on both the working list and the completed table. (FR #0000045)",
    "The data was already there and simply never made it to the screen: the case list query has always selected createdBy and normalised it (stripping the internal \"user:\" prefix), and it reached the row type — it was dropped one layer later, on the way into the table. So this is a column over an existing field, not a new one",
    "Every operator is @core.tech, so the column shows the local part and keeps the full address in the tooltip — a domain repeated identically on every row is a column's worth of noise. A non-email actor (\"servicenow-poller\") has no @ and renders unchanged, because that is already its readable form",
    "A case with nobody recorded shows a dash rather than an empty cell, so \"nobody\" and \"didn't load\" don't look the same",
    "Worth stating plainly: this is who OPENED the case. The app has no assignment model — the ServiceNow poller imports cases precisely because they are unassigned there — so a real claim-a-case feature would be a separate request",
  ],
};
