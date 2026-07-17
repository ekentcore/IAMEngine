// Page data for /feature-requests — lived in settings/_lib while the admin editor was a Settings
// block; both moved here when feature requests got their own page.
import { db } from "@/lib/db";
import { toFeatureRequestRow, type FeatureRequestRow } from "@/lib/feature-requests/serialize";

export async function loadFeatureRequests(): Promise<FeatureRequestRow[]> {
  const rows = await db.featureRequest.findMany({ orderBy: { number: "desc" } });
  const now = new Date(); // one clock for the whole page, so the split can't straddle a tick
  return rows.map((r) => toFeatureRequestRow(r, now));
}
