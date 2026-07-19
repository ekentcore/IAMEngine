import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-runner-1740",
  date: "2026-07-18",
  time: "19:00",
  title: "Change/mover: runner 1.74.0 + directory-sync on change",
  items: [
    "Runner 1.74.0 ships the AD/M365/Exchange/Google change lanes; a mover that edits AD attributes now triggers a directory sync (directory-sync gets a Change scriptblock alongside its existing Onboard/Offboard), and entra inherits the m365 change lane through the existing alias",
    "Runner + the change-action migration need deploy",
  ],
};
