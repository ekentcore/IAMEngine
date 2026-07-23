import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "runner-pool-one-box",
  date: "2026-07-23",
  time: "01:00",
  title: "Run a pool of runner processes on one box — redundancy, peer-restart, and parallel jobs",
  items: [
    "A new pool supervisor (Start-IamRunnerPool.ps1) can run N runner processes on a single host. Each member is a full, unchanged runner with its own distinct, server-minted agent id at equal priority and the same scope — so the app's existing load-balancing claim splits the queue across them and runs different clients/systems in parallel, with no server change",
    "The correctness boundary is one agent id per process: two processes sharing an id would double-execute every job, so member identities live in a persisted local roster (.runner-pool.json), lazy-enrolled once via the existing enroll API and reused across restarts",
    "Members no longer evict each other: the single-instance lock is now keyed per agent (.runner.<agentId>.lock) instead of one per folder, so N members coexist while newest-PID-wins still guards each member against a stale self-update leftover",
    "Peer-restart is built in: the supervisor health-checks each member (reusing the existing stall-watchdog decision) and relaunches a dead or wedged one within a check interval; on its own restart it adopts already-live members instead of double-spawning",
    "Pool-aware self-update: the supervisor pulls the new build ONCE for the whole folder and restarts members staggered, instead of N processes racing to pull into one folder and cold-starting in a stampede",
    "Safety gate (feature #4): the supervisor reads the governorActive signal off a heartbeat and REFUSES -PoolSize > 1 while the concurrency governor is inactive — running a single member and auto-scaling up once the governor is enabled — because an ungoverned pool could run the same tenant+system concurrently (incident UM0029840 across processes)",
    "Installers thread -PoolSize / POOL_SIZE (install-launchd.sh, install-systemd.sh, install-task.ps1); PoolSize 1 is the default and launches the runner directly, byte-identical to today's single-agent installs — nothing changes for the ~200 existing agents",
    "Runner 1.95.0 — NEEDS DEPLOY. This is the single coordinated version bump covering the pool plus feature #7's drain-honoring. Stand the central cloud runner up as a pool first (highest volume), validate same-tenant serialization under the governor, then extend to high-volume client boxes",
  ],
};
