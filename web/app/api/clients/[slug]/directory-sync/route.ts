// POST /api/clients/:slug/directory-sync — add directory-sync to a client in one atomic step:
// the ClientSystem row (so planning runs it), optionally backbone=ad_synced, and the runbook
// section in both onboard + offboard. Idempotent; fills only what's missing.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { auditActor } from "@/lib/auth/audit";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { addDirectorySyncToClient } from "@/lib/clients/add-directory-sync";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { orderAfter?: unknown; setAdSynced?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // empty/invalid body → defaults below
  }
  const orderAfter = body.orderAfter === "exchange" ? "exchange" : "active-directory";
  const setAdSynced = Boolean(body.setAdSynced);

  const result = await addDirectorySyncToClient(db, params.slug, { orderAfter, setAdSynced }, auditActor(_g.user, "ui"));
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(result);
}
