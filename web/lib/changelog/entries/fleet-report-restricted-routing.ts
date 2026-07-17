import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-report-restricted-routing",
  date: "2026-07-17",
  time: "12:45",
  title: "The M365 fleet permission report routes restricted clients to the restricted chat room",
  items: [
    "The fleet permission report now splits by each client's restricted flag: restricted clients (e.g. Coretelligent) go as their own report to the restricted chat destinations, everyone else to the regular (all-clients) ones - before this, the whole batch went wherever the --audience flag pointed, which put restricted clients' permission state in the regular room",
    "Each side gets a complete, correctly-scoped report - its own totals, sections and part numbers - and the restricted one is titled \"restricted clients\" so its small count is not mistaken for the fleet",
    "If restricted clients exist but no restricted destination is configured, that segment fails loudly (non-zero exit, named in the output) instead of falling back to the regular room - restricted data is never sent there",
    "A permission row that cannot be matched to a client routes to the restricted room, not the regular one - when we do not know whether a client is restricted, we assume it is",
    "The --audience flag is gone and now errors with an explanation; --only regular|restricted resends a single segment after a partial failure",
  ],
};
