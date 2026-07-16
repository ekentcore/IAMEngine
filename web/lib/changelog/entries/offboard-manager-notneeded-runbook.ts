import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-manager-notneeded-runbook",
  date: "2026-07-13",
  time: "16:30",
  title: "Offboard: manager hand-off to Exchange, not-needed steps, full runbook (runner 1.47.0)",
  items: [
    "The Active Directory offboard step now names the manager it clears in the run report, instead of just saying \"cleared manager\"",
    "That manager is handed to the Exchange step, which grants them Full Access to the departing user's shared mailbox - previously, if Exchange ran after AD (a re-run), the link was already gone and the delegate was silently skipped",
    "A system whose credentials are all marked \"not needed\" is now planned as a manual checklist item instead of failing the case at the credential broker",
    "The client runbook now shows systems that run on a case but were never written up in the KB article, flagged \"not in the KB doc\"",
  ],
};
