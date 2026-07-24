import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fix-migrate-workingdir",
  date: "2026-07-24",
  time: "08:45",
  title: "Agent URL migration no longer aborts on a Scheduled Task with no working directory",
  items: [
    "Moving the app to a new hostname (heartbeat migrate) rewrites each Windows agent's 'iam-runner' Scheduled Task to point at the new URL; the rewrite failed with 'Cannot validate argument on parameter WorkingDirectory. The argument is null or empty' whenever the existing task had no working directory set (older installs, or a hand-made task), so the agent reported 'rewrite failed' and correctly stayed on the OLD URL",
    "New-ScheduledTaskAction's -WorkingDirectory is validated as not-null-or-empty; we now only pass it when there is a value, falling back to the runner's install directory - so the rewrite succeeds regardless of how the task was originally created",
    "No behaviour change for tasks that already carry a working directory (the common install-task.ps1 path); this only unblocks the ones that didn't",
    "Runner 1.96.1 - agents pick this up on self-update; a stuck migrate will then complete on the next migrate heartbeat",
  ],
};
