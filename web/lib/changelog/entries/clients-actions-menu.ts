import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "clients-actions-menu",
  date: "2026-07-20",
  time: "15:15",
  title: "Client page actions moved into one 'Actions ▾' menu",
  items: [
    "The client detail header was a long row of standalone buttons (Name update, Re-plan open cases, Edit systems, Change / move user, Set up M365 automatically, Guided setup) — they now collapse behind a single 'Actions ▾' dropdown, so the header reads clean and the status pills (restrict / engine / own-agent) aren't crowded out",
    "Every action still does exactly what it did: Name update and Re-plan run in place and leave their result note under the button; Edit systems, Change / move user and Set up M365 open their existing dialogs",
    "The M365 setup and Change / move dialogs gained an optional controlled-open mode so the menu can drive them — the M365 run's live progress + log still render on the page (not trapped in the closed menu), so a long-running setup stays watchable",
    "No behaviour or API change — purely a header tidy-up; the three single-use button wrappers were folded into the new menu component",
  ],
};
