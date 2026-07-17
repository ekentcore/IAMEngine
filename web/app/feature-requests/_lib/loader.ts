// Page data for /feature-requests — lived in settings/_lib while the admin editor was a Settings
// block; both moved here when feature requests got their own page.
import { db } from "@/lib/db";
import { toFeatureRequestRow, type FeatureRequestRow } from "@/lib/feature-requests/serialize";

export async function loadFeatureRequests(): Promise<FeatureRequestRow[]> {
  const rows = await db.featureRequest.findMany({ orderBy: { number: "desc" } });
  const now = new Date(); // one clock for the whole page, so the split can't straddle a tick
  return rows.map((r) => toFeatureRequestRow(r, now));
}

// The nav badge's open count — a cheap COUNT rather than loading every row, mirroring
// outdatedAgentCount() in the layout. An open status (new/planned/building) always has hideAt = null
// (moving back to an open status cancels the timer, and an open request can't be hidden), so "not a
// terminal status" is exactly "on the board and open" — no hideAt comparison needed here.
export async function openFeatureRequestCount(): Promise<number> {
  return db.featureRequest.count({ where: { status: { notIn: ["done", "declined"] } } });
}
