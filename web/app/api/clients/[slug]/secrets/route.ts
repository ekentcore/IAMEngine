// GET  /api/clients/:slug/secrets — the client's secret wiring: one row per secretName its systems
//                                    reference, merged with the saved Delinea reference (id/label).
// PUT  /api/clients/:slug/secrets — upsert the references (name -> id + label). Stores only refs.
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { deriveSecretRows } from "@/lib/secrets/wiring";
import { delineaConfigured, delineaConfigFromEnv } from "@/lib/secrets/delinea";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const wiring = await makeClientRepository(db).secretsWiring(params.slug);
  if (!wiring) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    rows: deriveSecretRows(wiring.systems, wiring.secrets),
    delineaConfigured: delineaConfigured(delineaConfigFromEnv()),
  });
}

type Entry = { name: string; externalId: string; label?: string | null };

function sanitize(s: unknown): Entry | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  return {
    name,
    externalId: typeof o.externalId === "string" ? o.externalId.trim() : "",
    label: typeof o.label === "string" && o.label.trim() !== "" ? o.label.trim() : null,
  };
}

export async function PUT(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { secrets?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  if (!Array.isArray(body.secrets)) {
    return NextResponse.json({ error: "secrets[] is required" }, { status: 422 });
  }
  const entries = body.secrets.map(sanitize).filter((e): e is Entry => e !== null);
  const deduped = [...new Map(entries.map((e) => [e.name, e])).values()];

  const repo = makeClientRepository(db);
  const wiring = await repo.secretsWiring(params.slug);
  if (!wiring) return NextResponse.json({ error: "not found" }, { status: 404 });

  await repo.upsertSecrets(wiring.clientId, deduped);
  // Audit names only — never the ids (references) or values.
  await repo.writeAudit({
    actor: "ui",
    action: "client.secrets.edit",
    clientId: wiring.clientId,
    detail: { secrets: deduped.map((e) => e.name) },
  });
  return NextResponse.json({ saved: deduped.length });
}
