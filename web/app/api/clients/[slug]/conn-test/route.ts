// POST /api/clients/:slug/conn-test — queue a connection/permission preflight for each of the
//   client's api systems that connects to something (replaces any prior run). The runner claims
//   these on its next poll, connects with the brokered credential, does one read, and reports back.
// GET  /api/clients/:slug/conn-test — current results (for the panel to poll).
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { recordAudit, auditActor } from "@/lib/auth/audit";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Optional body: { systemKey } retests ONE system (its row is replaced, the rest survive).
  // The existing "Test connections" button sends no body — whole-client semantics unchanged.
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const systemKey = typeof body?.systemKey === "string" && body.systemKey.trim() ? body.systemKey.trim() : undefined;
  // { deep: true } additionally permits INTERACTIVE probes — today, signing in to a vendor's portal in
  // a real browser. It must be asked for EXPLICITLY, never inferred from "a systemKey was supplied":
  // save-and-test posts a systemKey for every system a changed secret touches, so editing the Spanning
  // API token would otherwise fire a real M365 admin sign-in as a side effect of pressing Save.
  const deep = body?.deep === true && Boolean(systemKey);
  try {
    const out = await makeRunnerService(db).requestConnectionTests(params.slug, systemKey, "manual", deep, auditActor(g.user, "ui").userId);
    const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true } });
    await recordAudit("conntest.request", { user: g.user, clientId: client?.id ?? null, detail: { systemKey: systemKey ?? "*", queued: out.tests.length } });
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guardAuth(); if (g.res) return g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const out = await makeRunnerService(db).listConnectionTests(params.slug);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
