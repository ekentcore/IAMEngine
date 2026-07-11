// POST /api/clients/:slug/conn-test — queue a connection/permission preflight for each of the
//   client's api systems that connects to something (replaces any prior run). The runner claims
//   these on its next poll, connects with the brokered credential, does one read, and reports back.
// GET  /api/clients/:slug/conn-test — current results (for the panel to poll).
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/auth/audit";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  // Optional body: { systemKey } retests ONE system (its row is replaced, the rest survive).
  // The existing "Test connections" button sends no body — whole-client semantics unchanged.
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const systemKey = typeof body?.systemKey === "string" && body.systemKey.trim() ? body.systemKey.trim() : undefined;
  try {
    const out = await makeRunnerService(db).requestConnectionTests(params.slug, systemKey);
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
  try {
    const out = await makeRunnerService(db).listConnectionTests(params.slug);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
