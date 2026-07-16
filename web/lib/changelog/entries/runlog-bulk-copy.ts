import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "runlog-bulk-copy",
  date: "2026-07-14",
  time: "16:00",
  title: "Tick several run-log errors and copy them all in one click",
  items: [
    "The run log already let you multi-select open errors and warnings, but the only thing you could do with a selection was mark it Fixed. Copying the failures out - into a ticket, a chat, or a prompt - meant clicking the per-line copy button once per line",
    "There is now a Copy button in the selection toolbar, to the left of Fix: tick as many lines as you like and 'Copy 4' puts all four on the clipboard at once, each with its module, case number, message, error and credential detail, exactly as the per-line copy gives them",
  ],
};
