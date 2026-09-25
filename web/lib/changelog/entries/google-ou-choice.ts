import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-ou-choice",
  date: "2026-09-22",
  time: "19:45",
  title: "Google Workspace: choose the OU for onboards and offboards",
  items: [
    "Edit systems has Onboarding OU and Offboarding OU fields on a client's Google Workspace system - where new users are created and where leavers are moved. Blank keeps the defaults (/Active Users and /Email & Calendar/Inactive)",
    "A single case can use a different OU: cases with a Google step show the OU they'll use with a Save button, and \"Use client default\" to undo it. The choice survives a re-import from ServiceNow",
    "The root OU (/) is refused, and so is a path that doesn't start with /",
  ],
};
