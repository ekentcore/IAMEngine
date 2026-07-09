// POST /api/clients/:slug/conn-test — queue a connection/permission preflight for each of the
//   client's api systems that connects to something (replaces any prior run). The runner claims
//   these on its next poll, connects with the brokered credential, does one read, and reports back.
// GET  /api/clients/:slug/conn-test — current results (for the panel to poll).
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  try {
    const out = await makeRunnerService(db).requestConnectionTests(params.slug);
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
