// Shared server-side loader for the Settings pages (/settings and /settings/v2 — keep both thin).
import { db } from "@/lib/db";
import type { FeatureRequestRow } from "../_components/feature-requests-admin";

export async function loadFeatureRequests(): Promise<FeatureRequestRow[]> {
  const rows = await db.featureRequest.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    page: r.page,
    status: r.status,
    resolutionNote: r.resolutionNote,
    authorEmail: r.authorEmail,
    createdAt: r.createdAt.toISOString(),
  }));
}
