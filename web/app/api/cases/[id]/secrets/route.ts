// GET   /api/cases/:id/secrets        — the case's effective secret references (source/server/systems).
// PATCH /api/cases/:id/secrets         — { name, externalId } set (or clear with empty) a per-case override.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { caseSecretStatus, setCaseSecretOverride } from "@/lib/cases/case-secrets-repo";
import { delineaConfigured, delineaConfigFromEnv } from "@/lib/secrets/delinea";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const secrets = await caseSecretStatus(db, params.id);
  if (secrets === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ secrets, delineaConfigured: delineaConfigured(delineaConfigFromEnv()) });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  let body: { name?: unknown; externalId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 422 });
  const externalId = typeof body.externalId === "string" ? body.externalId.trim() : "";

  const exists = await db.caseRequest.findUnique({ where: { id: params.id }, select: { id: true, clientId: true } });
  if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Only allow overriding a secret the case's jobs actually reference (no orphan keys).
  const before = await caseSecretStatus(db, params.id);
  if (!before?.some((s) => s.name === name)) {
    return NextResponse.json({ error: `secret '${name}' is not used by this case` }, { status: 422 });
  }

  await setCaseSecretOverride(db, params.id, name, externalId || null);
  await db.auditLog.create({
    data: { actor: "ui", action: externalId ? "case.secret.override.set" : "case.secret.override.clear", clientId: exists.clientId, detail: { caseId: params.id, secretName: name } },
  });
  const secrets = await caseSecretStatus(db, params.id);
  return NextResponse.json({ secrets });
}
