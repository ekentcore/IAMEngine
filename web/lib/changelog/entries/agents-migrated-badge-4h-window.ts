import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "agents-migrated-badge-4h-window",
  date: "2026-07-24",
  time: "13:00",
  title: "The '✓ migrated' badge on the Agents page now retires 4 hours after the move, instead of staying forever",
  items: [
    "Once an agent finished moving to a new app URL, its row kept showing the '✓ migrated' banner indefinitely — long after the move was settled and no longer news. The banner now appears for 4 hours after the migration completes, then disappears on its own",
    "This only changes the row banner on the Agents page. The underlying migratedAt timestamp is untouched, so go-live, cutover, fleet-health, and other migration-correctness surfaces are unaffected",
  ],
};
