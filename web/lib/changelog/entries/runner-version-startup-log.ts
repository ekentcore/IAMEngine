import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "runner-version-startup-log",
  date: "2026-07-15",
  time: "11:45",
  title: "The server now logs which runner version it serves to agents, every time it starts",
  items: [
    "On startup the app prints one line - e.g. 'serving v1.60.0 · build acf9ba83 · 68 files' - naming the exact runner version and build it will hand to agents. Agents self-update from whatever the app serves off its own disk, so this line is the ground truth for what your agents will update to",
    "This makes a stale deploy obvious: if you ship a runner change but the server still logs the old version on restart, the app is running pre-pull code and agents will never see the update - pull and restart the app onto the new code first",
    "Log only - no behaviour change, nothing new exposed in the UI or to agents",
  ],
};
