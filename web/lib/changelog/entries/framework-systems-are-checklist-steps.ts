import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "framework-systems-are-checklist-steps",
  date: "2026-07-13",
  time: "19:45",
  title: "Case resolution + ServiceNow are checklist steps again (not fake API steps)",
  items: [
    "Case resolution was wired as an automated step on 129 clients, but no executor exists for it - every case dispatched a job that came straight back as 'skipped - no executor', and operators were hand-marking it done",
    "Those 130 rows are now manual checklist steps, so the run report prompts you to close the ticket instead of showing a misleading skipped line",
    "The Modules page no longer claims ServiceNow and Case resolution are 'built' - nothing in the app writes a ServiceNow ticket's state today (work notes only, and only when write-back is enabled)",
    "Next up: a real ServiceNow write executor to close the ticket automatically - blocked on a write-capable API key",
  ],
};
