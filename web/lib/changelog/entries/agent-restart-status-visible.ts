import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "agent-restart-status-visible",
  date: "2026-07-15",
  time: "14:30",
  title: "The Agents page now shows a 'restart queued / restarting' status when you restart a runner",
  items: [
    "Clicking Restart on a runner used to give no visible feedback in the newer Agents view (v2) - the action lives in the 'Actions' menu, which closes the moment you click, so the 'Restarting...' label was hidden and it looked like nothing happened. The restart was actually queued; you just couldn't see it",
    "A restart status line now shows on the runner's row itself, in both the classic and v2 views: 'restart queued - waiting for the runner to poll', then 'restarting - re-launching', then 'restarted - runner back online', with the operator who requested it",
    "The row refreshes on its own while a restart is in flight (same 4-second live poll the Update flow already used), so the status advances and clears without a manual page refresh",
  ],
};
