import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "concurrency-governor",
  date: "2026-07-22",
  time: "23:30",
  title: "Concurrency governor: cap how much runs at once, per client and per system",
  items: [
    "New admission stage in the job-claim path enforces three in-flight caps: a fleet-wide limit, a per-client limit, and the key safety rule - at most one job at a time for the same client+system, so two runs can never collide on a shared Microsoft 365 / Exchange / browser session (the class of bug behind incident UM0029840)",
    "The count-and-claim is serialized fleet-wide with a Postgres advisory lock, so the caps hold even when several runners claim at the same instant - not just best-effort; a capped job simply stays pending and is picked up on the next check-in, never failed",
    "Child accounts count against their PARENT tenant (they share the parent's M365/Exchange session), and one-off actions - password resets, force-sync, single-step re-runs - are exempt from the caps so an operator side-action is never blocked",
    "Ships DARK and fail-open: the governor is off by default and does nothing until switched on in settings; an absent or unreadable config can never wedge dispatch",
    "The heartbeat now reports whether the governor is active, so the upcoming multi-runner pool can refuse to run more than one runner until the governor is on",
  ],
};
