// Server half of the admin attention modal: the two indexed aggregates the layout runs for
// global_admin+ viewers (AccessRequest has @@index([status, lastRequestedAt]); FeatureRequest
// number is unique). Failure-safe by contract — the layout must never break because of this
// feature, so any DB error degrades to "nothing pending".
import { db } from "@/lib/db";
import type { AttentionData } from "./seen";

export async function adminAttentionData(): Promise<AttentionData> {
  try {
    const [req, fr] = await Promise.all([
      db.accessRequest.aggregate({
        where: { status: "pending" },
        _count: { _all: true },
        _max: { lastRequestedAt: true },
      }),
      db.featureRequest.aggregate({
        where: { status: "new" },
        _count: { _all: true },
        _max: { number: true },
      }),
    ]);
    return {
      pendingRequests: req._count._all,
      latestRequestAt: req._max.lastRequestedAt?.toISOString() ?? null,
      newFeatureRequests: fr._count._all,
      maxFrNumber: fr._max.number ?? 0,
    };
  } catch {
    return { pendingRequests: 0, latestRequestAt: null, newFeatureRequests: 0, maxFrNumber: 0 };
  }
}
