// POST /api/clients/:slug/systems/sync-from-runbook — wire any modeled system the saved runbook
// references but the client lacks (catalog defaults; never touches existing rows). The client
// page's "Sync systems from runbook" button, for runbooks saved before the save-time sync existed
// or after a KB/runbook edit.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { syncSystemsFromRunbook } from "@/lib/clients/runbook-repo";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const res = await syncSystemsFromRunbook(db, params.slug);
  if (!res) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(res);
}
