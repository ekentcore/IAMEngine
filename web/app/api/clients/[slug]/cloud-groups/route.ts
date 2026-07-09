// POST /api/clients/:slug/cloud-groups — queue a cloud (Entra) group discovery. The CENTRAL runner
// picks it up on its next poll, reads the tenant's groups via the m365-admin secret, and posts them
// back to back the group pickers (DLs / Security / M365 Groups).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;
  try {
    const out = await makeRunnerService(db).requestCloudGroupDiscovery(params.slug);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
