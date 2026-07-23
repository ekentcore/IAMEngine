import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "per-agent-runner-auth",
  date: "2026-07-23",
  time: "07:45",
  title: "Runners now authenticate with a per-agent token instead of the shared key",
  items: [
    "Runners now authenticate with a per-agent token instead of the shared key; switch the fleet over and rotate tokens remotely from the Agents page.",
  ],
};
