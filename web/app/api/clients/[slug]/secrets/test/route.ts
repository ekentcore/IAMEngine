// POST /api/clients/:slug/secrets/test — preflight: resolve each Delinea reference to prove (a) the
// app can READ it (the account has Read on the secret) and (b) it carries the FIELDS its provider's
// connector needs (e.g. m365-admin has a TenantId, exchange a CertificateThumbprint, mimecast a
// client id + secret). Tests the ids in the request body (the engineer's current edits) so "Test"
// reflects what's on screen, saved or not. The shape check reads the secret like the broker does,
// but ONLY field NAMES and missing-requirement LABELS are returned — values never leave the server.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { resolveSecretFields, delineaConfigFromEnv, delineaConfigured, getDelineaToken } from "@/lib/secrets/delinea";
import { checkFieldShape } from "@/lib/secrets/field-requirements";
import {
  classifyM365Credential,
  probeEntraClientCredentials,
  pickField,
  M365_APPID_FIELDS,
  M365_SECRET_FIELDS,
  M365_TENANT_FIELDS,
} from "@/lib/secrets/m365-credential";

export const dynamic = "force-dynamic";

type TestItem = { name: string; externalId: string };

export async function POST(req: Request, { params }: { params: { slug: string } }) {
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

  const repo = makeClientRepository(db);
  const wiring = await repo.secretsWiring(params.slug);
  if (!wiring) return NextResponse.json({ error: "not found" }, { status: 404 });

  const items: TestItem[] = body.secrets
    .map((s): TestItem | null => {
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (!name) return null;
      return { name, externalId: typeof o.externalId === "string" ? o.externalId.trim() : "" };
    })
    .filter((i): i is TestItem => i !== null);

  // The client's primary domain can supply the M365 tenant even when the secret has no TenantId field.
  const client = await db.client.findUnique({ where: { id: wiring.clientId }, select: { primaryDomain: true } });
  const hasTenantHint = Boolean(client?.primaryDomain && client.primaryDomain.trim());

  const cfg = delineaConfigFromEnv();
  // One token for the whole batch ("Test all") — not one password-grant per secret.
  let token: string | undefined;
  try {
    if (delineaConfigured(cfg)) token = await getDelineaToken(cfg);
  } catch {
    // leave token undefined — each resolve reports the auth failure itself.
  }
  const results = await Promise.all(
    items.map(async (i) => {
      const r = await resolveSecretFields(cfg, i.externalId, undefined, token);
      if (!r.ok) return { name: i.name, ok: false, error: r.error };
      // Shape check on field NAMES only — values are never read into the response.
      const shape = checkFieldShape(i.name, Object.keys(r.fields ?? {}), { clientHasTenantHint: hasTenantHint });

      // m365-admin gets two extra checks a name-only shape check cannot make, because a Global Admin
      // account and an app registration BOTH carry a Username + Password:
      //   1. kind  — the value's shape (a UPN is a person, a GUID is an app). Free, instant.
      //   2. live  — the real client-credentials grant against Entra: the same handshake
      //              Connect-MgGraph -ClientSecretCredential performs, so a pass here means the
      //              runner WILL connect. This is the definitive answer, and it costs one HTTPS call.
      // Neither ever puts a credential value in the response.
      if (i.name === "m365-admin" && r.fields) {
        const kind = classifyM365Credential(r.fields);
        if (kind.kind !== "app-registration") {
          return { name: i.name, ok: false, label: r.label, error: kind.reason, credKind: kind.kind, missingFields: shape.missing };
        }
        const appId = pickField(r.fields, M365_APPID_FIELDS);
        const secret = pickField(r.fields, M365_SECRET_FIELDS);
        const tenant = pickField(r.fields, M365_TENANT_FIELDS) ?? client?.primaryDomain ?? undefined;
        if (appId && secret && tenant) {
          const probe = await probeEntraClientCredentials(tenant, appId, secret);
          if (!probe.ok) {
            return {
              name: i.name,
              ok: false,
              label: r.label,
              error: `Entra rejected this credential (${probe.errorCode ?? probe.error})${probe.hint ? ` — ${probe.hint}` : ""}`,
              credKind: kind.kind,
              missingFields: shape.missing,
            };
          }
          return { name: i.name, ok: true, label: r.label, missingFields: shape.missing, credKind: kind.kind, liveAuth: true };
        }
      }
      return { name: i.name, ok: true, label: r.label, missingFields: shape.missing };
    })
  );

  await repo.writeAudit({
    actor: "ui",
    action: "client.secrets.test",
    clientId: wiring.clientId,
    detail: { tested: results.length, passed: results.filter((r) => r.ok).length },
  });
  return NextResponse.json({ results });
}
