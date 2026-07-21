// POST /api/clients/:slug/cloud-groups — queue a cloud (Entra) group discovery. The CENTRAL runner
// picks it up on its next poll, reads the tenant's groups via the m365-admin secret, and posts them
// back to back the group pickers (DLs / Security / M365 Groups).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { auditActor } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    // Pass the operator so the runner's later result audit is attributed to them, not "agent:<id>".
    const out = await makeRunnerService(db).requestCloudGroupDiscovery(params.slug, auditActor(g.user, "ui"));
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
