import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "v3-menus-collapsible-sections",
  date: "2026-07-22",
  time: "17:45",
  title: "Version 3 UI: v1 retired, slider is now v2/v3, case actions menu + collapsible sections",
  items: [
    "The version slider now toggles v2 ⇄ v3. v1 is retired — any v1 page automatically redirects to v2.",
    "Case page: the row of top buttons (schedule, pause, re-plan, reveal password, link/hard-match, domain) is now one “Actions ▾” menu, matching the client page.",
    "Every section on the case page — Playbook, Credentials, Run report, Planned steps, Manual checklist, Intake — is now collapsible.",
    "New /v3 pages for every versioned area (clients, cases, audit, users, agents, runs, modules, health, connections, settings, account, changelog), sharing each page’s existing data and views.",
  ],
};
