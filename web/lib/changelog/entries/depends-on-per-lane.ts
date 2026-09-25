import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "depends-on-per-lane",
  date: "2026-09-22",
  time: "19:00",
  title: "Systems: separate onboard and offboard \"depends on\"",
  items: [
    "Edit systems now has two fields, Onboard depends on and Offboard depends on, instead of one list shared by both - so a system can wait on different steps when onboarding and offboarding",
    "Existing systems open with the same list in both fields, and saving them unchanged stores them exactly as before",
  ],
};
