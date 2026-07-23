import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "graceful-drain-maintenance-mode",
  date: "2026-07-22",
  time: "23:00",
  title: "Maintenance mode: drain the fleet before a host cutover",
  items: [
    "New Maintenance & drain card in Settings (Global/Super admin) - a global toggle pauses all dispatch fleet-wide: no new job is handed out, and every runner finishes the job it's already running then idles until you clear it",
    "The banner tracks the drain live - 'Draining - N jobs still running' flips to 'Fully drained - safe to cut over' once nothing is dispatched or running, so you know exactly when it's safe to pull the switch",
    "Scoped pauses (collapsible): hold dispatch for specific systems (e.g. mimecast while its API is down) or specific clients, without idling the runners on their other work",
    "Resume is a single click - clearing maintenance lets runners pick up where they left off on their next check-in, no restart and no re-plan; any job left waiting through the drain runs in its normal order",
    "Fail-open and idempotent throughout: an absent or unreadable setting never pauses the fleet by accident, and toggling repeatedly is safe",
  ],
};
