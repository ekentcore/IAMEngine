import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-health-dashboard-alerting",
  date: "2026-07-23",
  time: "00:15",
  title: "New Fleet health board + proactive alerts for agents, queue, failures, and backups",
  items: [
    "Added a read-only Fleet health board at /health/fleet (More → Reference → Fleet health) that aggregates, at a glance, every fleet signal you used to hunt for: each agent's online/at-risk/offline state, last-seen, build version vs the served build, active/standby role, and Azure-migration state; queue depth + oldest-pending + wedged/stale jobs; recent-failure clustering; database-backup freshness; and database health",
    "The board refreshes itself every ~25s and shows a one-line verdict (\"Fleet healthy\" or \"N conditions need attention\") plus any alerts currently firing",
    "Added four proactive chat alerts, delivered through the existing failure-notification channels and master switch: an agent going offline, the job queue backing up, job failures clustering, and the nightly database backup going stale (silently stopping) — each with its own on/off toggle in Settings",
    "Alerts don't spam: each condition re-alerts at most once per cooldown window, clears when it recovers, and a mass agent-outage (e.g. during the Azure move) collapses into a single digest instead of one message per agent",
    "Alert thresholds (how long offline before paging, queue depth, failure count/window, backup max age, cooldown) have sensible defaults and are configurable; database-down is shown on the board but deliberately not a chat alert (a database-backed check can't reliably alert on its own database being down — external uptime monitoring covers that)",
  ],
};
