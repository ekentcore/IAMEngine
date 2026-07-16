import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "exchange-manager-name",
  date: "2026-07-13",
  time: "16:45",
  title: "Offboard: Exchange now uses the manager the intake form names (runner 1.48.0)",
  items: [
    "The offboard form carries the manager as a NAME (\"managerName\"), which the Exchange step never read - it only understood email addresses, so it skipped the Full Access delegate even when the case named the manager",
    "Exchange now resolves that name to a mailbox (Exchange Online first, then on-prem AD) and grants them Full Access to the shared mailbox",
    "A name matching several mailboxes is never guessed at - the step warns and skips instead",
  ],
};
