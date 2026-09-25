import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-ou-picker",
  date: "2026-09-23",
  time: "09:15",
  title: "Google Workspace: pick the OU from the tenant's own list (runner 1.133.0)",
  items: [
    "Edit systems has a Refresh Google OUs button on a client's Google Workspace system: the runner reads the tenant's OUs and the Onboarding OU and Offboarding OU fields then suggest them as you type",
    "The per-case Google OU on a case page suggests the same list",
    "You can still type any path; if a refresh fails, the last list is kept and the reason is shown",
  ],
};
