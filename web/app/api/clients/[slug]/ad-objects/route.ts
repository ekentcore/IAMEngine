// POST /api/clients/:slug/ad-objects — ask the client's on-prem agent to (re)discover AD OUs+groups.
// The next client-network heartbeat for this client picks it up and runs read-only AD reads.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const res = await makeRunnerService(db).requestAdDiscovery(params.slug);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
