import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "exo-mirror-bounded-timeout",
  date: "2026-07-22",
  time: "16:15",
  title: "A stalled shared mailbox can no longer wedge an M365 onboard (and block Adobe, etc.)",
  items: [
    "The M365 onboard's \"mirror shared-mailbox permissions\" finishing step scans every shared mailbox in the tenant with one un-timed Exchange Online read each. A single dropped/stalled EXO session on one mailbox used to hang the whole onboard — and every system that depends on M365 (Adobe, Mimecast, …) stalled behind it — until the runner's stall watchdog restarted the process",
    "That mirror is best-effort, so it no longer gets to hold the onboard hostage: it now runs time-bounded in its own background runspace (default 300s, override RUNNER_MIRROR_BUDGET_SECONDS). If it overruns, it's abandoned and the onboard finishes with a warning telling you to re-run the M365 step to complete mirroring",
    "While it runs, the step heartbeats every few seconds, so the run report shows live movement (\"mirroring shared-mailbox permissions … (bounded scan)\") instead of looking frozen, and the stall watchdog stays fed",
    "Fully backward-compatible: if the bounded runner can't be armed, it falls back to the previous inline behavior (still caught by the process watchdog) — never a regression in what gets mirrored",
    "Runner 1.91.0 — NEEDS DEPLOY. The child-runspace app-only EXO reconnect is pending live validation before rollout",
  ],
};
