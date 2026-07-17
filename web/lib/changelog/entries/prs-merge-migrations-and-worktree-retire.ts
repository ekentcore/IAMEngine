import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "prs-merge-migrations-and-worktree-retire",
  date: "2026-07-17",
  time: "07:00",
  title: "Merging a PR now offers to run its database migrations, and finished worktrees retire themselves",
  items: [
    "prs.sh detects when a just-merged PR shipped a Prisma migration and offers to run 'migrate deploy' right there (with approval) - the 'merged but the schema change was never applied' gap no longer depends on remembering",
    "After a squash merge, the worktree that carried the branch is retired automatically instead of accumulating; prs.sh --tidy (and --tidy --stale for locked leftovers from dead sessions) sweeps the rest",
  ],
};
