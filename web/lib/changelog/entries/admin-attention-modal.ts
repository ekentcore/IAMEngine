import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "admin-attention-modal",
  date: "2026-07-24",
  time: "19:00",
  title: "Admins now get a heads-up popup when something is waiting on them",
  items: [
    'Global and super admins see a "Needs your attention" popup when there are pending user access requests or new feature requests, with one-click links to review them',
    "It pops once per new item, not on every login: dismiss it and it stays quiet until something new actually arrives",
    "A new Popup test page under Tools lets admins preview every state of the popup without touching real data",
  ],
};
