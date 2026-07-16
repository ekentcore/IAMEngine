import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "engine-opt-out-hardening",
  date: "2026-07-13",
  time: "16:30",
  title: "Hardening: 'do not use engine' + parent inheritance (PR #41)",
  items: [
    "A 'do not use engine' client's trashed cases now STAY trashed - previously every intake sweep un-trashed them because the check ran after the restore",
    "The New case form now refuses an opted-out client too; the flag is enforced once at the case-creation layer, so no path can bypass it",
    "Breaking a child's parent link with 'Keep a copy' no longer merges the parent's systems onto a child that already has its own",
    "Breaking the link now always records, even when there's nothing to copy (the badge could get stuck on 'inherits')",
    "A child that brokers its parent's credentials no longer shows a false 'not set up' badge - readiness now mirrors what dispatch actually resolves",
    "The client page no longer claims 'inherits the parent's runbook' after the link is broken; clearing 'no engine' from the clients list now asks first",
  ],
};
