import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "manual-case-numbers-and-fix-status",
  date: "2026-07-14",
  time: "21:15",
  title: "Manual cases now get an IAM number, and a 'Fix with AI' stays marked running when you come back to the run log",
  items: [
    "A case you create by hand (not from a ServiceNow ticket) used to have a blank case number. It now gets an auto-assigned number - IAM0000001, IAM0000002, and so on - written into the same field ServiceNow cases use, so every case has exactly one number to quote. ServiceNow-sourced cases keep their own UM number untouched",
    "The IAM numbers come from a dedicated counter, so they stay contiguous: a ServiceNow case in between does not burn a number and leave a gap",
    "On the run log, clicking 'Fix with AI', navigating away, and coming back used to lose the queued/analyzing indicator - the line looked untouched even though the fix was still running. The page was serving a cached copy rendered before the fix existed. It now refreshes on click, so the running/queued state (and a ready-to-review proposal) is still there when you return",
  ],
};
