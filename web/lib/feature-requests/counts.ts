// The three figures the board reports, from ONE definition so the server page, the live client
// summary, and the nav badge can never disagree. "Open" = still remaining, i.e. not resolved
// (Implemented / Rejected); "implemented" = done. The archive timer is deliberately NOT read here:
// an implemented request is still implemented once it archives, and an open one has no timer.
import { frIsOpen } from "./status";
import type { FeatureRequestRow } from "./serialize";

export type FeatureRequestCounts = { total: number; open: number; implemented: number };

export function frCounts(rows: FeatureRequestRow[]): FeatureRequestCounts {
  let open = 0;
  let implemented = 0;
  for (const r of rows) {
    if (r.status === "done") implemented++;
    if (frIsOpen(r.status)) open++;
  }
  return { total: rows.length, open, implemented };
}
