// The three figures the board reports, from ONE definition so the server page, the live client
// summary, and the nav badge can never disagree. "Open" = still on the board (not hidden) and not a
// terminal status (done/declined); "implemented" = done.
import type { FeatureRequestRow } from "./serialize";

export type FeatureRequestCounts = { total: number; open: number; implemented: number };

export function frCounts(rows: FeatureRequestRow[]): FeatureRequestCounts {
  let open = 0;
  let implemented = 0;
  for (const r of rows) {
    if (r.status === "done") implemented++;
    if (!r.hidden && r.status !== "done" && r.status !== "declined") open++;
  }
  return { total: rows.length, open, implemented };
}
