import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "feature-requests-own-page",
  date: "2026-07-17",
  time: "12:00",
  title: "Feature requests get their own page, and the change log's evening timestamps are honest again",
  items: [
    "Feature-request management moved out of Settings to the Feature requests page - the same admin editor (status, resolution note, hide/extend) now lives where the board is, and the page is in the navigation under Reference for everyone (read-only board below admin)",
    "Settings keeps a one-line pointer instead of the duplicated block (both the classic and v2 settings pages)",
    "Change-log times for everything shipped after 3:30pm on 7/16 were stamped with mid-day working times instead of when the work actually landed, so the evening looked empty: 16 entries re-stamped to their PR merge times (the mailbox-decision fix 4pm, the M365 password-reset permission 10pm, the twelve-request feature batch 10:15pm, the connector builder 11:45pm, the hardening batch 7:15am, the fleet permission report 9:30am)",
    "The prs.sh merge-tooling change (run a merged PR's database migrations with approval, retire finished worktrees automatically) had no entry at all - added",
  ],
};
