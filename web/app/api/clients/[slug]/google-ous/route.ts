// POST /api/clients/:slug/google-ous — queue a Google Workspace OU discovery (FR #81). The CENTRAL
// runner picks it up on its next poll, reads the tenant's OU paths with the google-workspace secret,
// and posts them back to back the Google OU pickers. GET returns the last discovered list.
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { auditActor } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { HttpError } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guardAuth(); if (g.res) return g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const c = await db.client.findUnique({ where: { slug: params.slug }, select: { googleOus: true, googleOusRequestedAt: true } });
  const v = (c?.googleOus ?? {}) as { ous?: string[]; discoveredAt?: string | null; error?: string };
  return NextResponse.json({ ous: v.ous ?? [], discoveredAt: v.discoveredAt ?? null, error: v.error ?? null, pending: Boolean(c?.googleOusRequestedAt) });
}

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    return NextResponse.json(await makeRunnerService(db).requestGoogleOuDiscovery(params.slug, auditActor(g.user, "ui")));
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
