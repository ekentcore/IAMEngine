import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "agent-url-migration",
  date: "2026-07-15",
  time: "15:45",
  title: "Agents can move to a new app domain by themselves - no reinstall on each on-prem network",
  items: [
    "Set a new app URL under Settings > Agent domain migration. Prove it on one agent with the Migrate button on the Agents page, then enable it fleet-wide.",
    "Each agent verifies it can reach the new URL, rewrites its own scheduled task / launchd / systemd entry, and switches - the old URL is removed once it reports in on the new one.",
    "If the new URL is unreachable or the rewrite fails, the agent stays on the old URL and the failure shows on its row in Agents; it retries on the next heartbeat.",
    "The Agents page shows each agent's current base URL and its migration status, so you can watch the fleet converge before retiring the old host. Needs runner 1.62.0.",
  ],
};
