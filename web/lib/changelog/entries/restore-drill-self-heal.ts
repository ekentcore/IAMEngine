import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "restore-drill-self-heal",
  date: "2026-07-26",
  time: "21:45",
  title: "The restore drill heals itself: a missing backup directory or dump is corrected, not fatal",
  items: [
    "The weekly restore drill died with 'no such file or directory' when the configured backup directory (or latest.dump inside it) didn't exist on the host running the app — the exact state after the move to the Azure container, whose filesystem has neither the Mac-era backup path nor any dump. Instead of failing on the missing precondition, the drill now creates the directory, and when the configured path can't exist on this host at all it falls back to a scratch directory",
    "No dump to drill against no longer ends the drill: the self-heal takes a fresh verified backup on the spot and restores that — a just-taken dump proves the dump→restore path end to end, which is the drill's whole job",
    "Every corrective action is recorded on the drill result and its audit row, and a drill that self-healed and then passed announces exactly what it fixed in chat — the same channel its failure would have used",
    "Fixed the silent-failure window that hid the 2026-07-23 drill death: settings loading now sits inside the run's try/catch, so a claimed run always records a result, writes its audit row, and alerts — it can no longer consume the weekly slot and vanish",
  ],
};
