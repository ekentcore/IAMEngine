// GET  /api/clients  — list clients (roster + modeled), auto-syncing from SN if stale.
// POST /api/clients  — manually add a client ("onboard a client").
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import type { Backbone } from "@prisma/client";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { deriveSlugFromParts } from "@/lib/clients/sync-service";
import { syncIfStale } from "@/lib/clients/stale-check";

export const dynamic = "force-dynamic";

const BACKBONES = ["entra", "google", "ad_synced", "ad_standalone"] as const;

export async function GET() {
  await syncIfStale(db, "system:auto");
  const repo = makeClientRepository(db);
  return NextResponse.json(await repo.listClients());
}

export async function POST(req: Request) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const primaryDomain = typeof body.primaryDomain === "string" ? body.primaryDomain.trim() : "";
  if (!name || !primaryDomain) {
    return NextResponse.json({ error: "name and primaryDomain are required" }, { status: 422 });
  }
  const backbone =
    typeof body.backbone === "string" && (BACKBONES as readonly string[]).includes(body.backbone)
      ? (body.backbone as Backbone)
      : null;
  const coreId = typeof body.coreId === "string" && body.coreId.trim() ? body.coreId.trim() : null;

  const repo = makeClientRepository(db);
  let slug = deriveSlugFromParts(coreId, name);
  if (await repo.slugExists(slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

  try {
    const client = await repo.createClient({ name, primaryDomain, backbone, coreId }, slug);
    await repo.writeAudit({
      actor: "ui",
      action: "client.add",
      clientId: client.id,
      detail: { name, primaryDomain, source: "manual" },
    });
    return NextResponse.json(client, { status: 201 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `could not create client: ${reason}` }, { status: 409 });
  }
}
