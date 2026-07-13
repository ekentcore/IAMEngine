// GET  /api/clients  — list clients (roster + modeled), auto-syncing from SN if stale.
// POST /api/clients  — manually add a client ("onboard a client").
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import type { Backbone } from "@prisma/client";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { fleetWideAccess } from "@/lib/auth/fleet-access";
import { deriveSlugFromParts } from "@/lib/clients/sync-service";
import { normalizeCoreId } from "@/lib/clients/core-id";
import { syncIfStale } from "@/lib/clients/stale-check";

export const dynamic = "force-dynamic";

const BACKBONES = ["entra", "google", "ad_synced", "ad_standalone"] as const;

export async function GET() {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  await syncIfStale(db, "system:auto");
  const repo = makeClientRepository(db);
  return NextResponse.json(await repo.listClients(await currentClientScope(db)));
}

export async function POST(req: Request) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;

  // Same fleet-wide bar as the import: an operator narrowed to a subset must not mint a NEW row —
  // in particular one carrying a restricted client's CORE id, which the import would then match in
  // preference to the restricted row it shadows.
  const fleet = await fleetWideAccess(db, _g.user.id);
  if (!fleet.ok) return NextResponse.json({ error: fleet.reason }, { status: 403 });

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
  // Store the CORE id in ONE canonical shape ("CORE1269") — a hand-typed "CORE-1269" would otherwise
  // be invisible to every lookup that normalizes first, and the import would create a duplicate row
  // for the same company (the unique constraint compares raw strings, so it wouldn't stop it).
  // REJECT anything that isn't a CORE id rather than storing it verbatim: this column is later
  // interpolated into a ServiceNow query (refresh-name -> fetchSnAccountByCoreId), where `^` is an
  // operator — a junk value there is a query-injection payload, not a typo.
  const rawCoreId = typeof body.coreId === "string" ? body.coreId.trim() : "";
  const coreId = rawCoreId ? normalizeCoreId(rawCoreId) : null;
  if (rawCoreId && !coreId) {
    return NextResponse.json({ error: 'CORE id must look like "CORE1234"' }, { status: 422 });
  }

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
