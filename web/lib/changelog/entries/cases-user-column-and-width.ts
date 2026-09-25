import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "cases-user-column-and-width",
  date: "2026-09-22",
  time: "17:15",
  title: "Cases: a User column, the date up front, and a page that fits the table",
  items: [
    "The Subject column is now User and shows just the person's name - the subject repeated the Action and client, so it moved into the tooltip. Search still matches the full subject",
    "Action and Start / off date now sit right after User, so each row reads who, what, when before the bookkeeping columns; the Completed table uses the same order",
    "The Cases page widens to fit the table (up to the window width) instead of stopping at a fixed width",
  ],
};
