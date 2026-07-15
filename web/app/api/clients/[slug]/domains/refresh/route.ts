// POST /api/clients/:slug/domains/refresh — pull the client's VERIFIED email domains from its M365
// tenant (Graph /domains via the m365-admin app registration). Read-only against the tenant; returns
// the option list for the client-page domain editor — the operator chooses which to offer, nothing
// is auto-saved here. Falls out with an actionable error when the cred or permission is missing.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { resolveSecretFields, delineaConfigFromEnv, delineaConfigured } from "@/lib/secrets/delinea";
import { pickField, M365_APPID_FIELDS, M365_SECRET_FIELDS, M365_TENANT_FIELDS } from "@/lib/secrets/m365-credential";
import { listTenantDomains } from "@/lib/m365/tenant-domains";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });

  const client = await db.client.findUnique({
    where: { slug: params.slug },
    select: { id: true, primaryDomain: true, emailDomain: true, domains: true, secrets: { where: { name: "m365-admin" }, select: { externalId: true } } },
  });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) return NextResponse.json({ error: "Delinea is not configured on the app — cannot resolve the m365-admin credential" }, { status: 502 });
  const externalId = client.secrets[0]?.externalId;
  if (!externalId) return NextResponse.json({ error: "no m365-admin secret is wired for this client — wire it on the Secrets panel first" }, { status: 409 });

  const resolved = await resolveSecretFields(cfg, externalId);
  if (!resolved.ok || !resolved.fields) return NextResponse.json({ error: `could not resolve the m365-admin secret: ${resolved.error ?? "unknown error"}` }, { status: 502 });
  const appId = pickField(resolved.fields, M365_APPID_FIELDS);
  const secret = pickField(resolved.fields, M365_SECRET_FIELDS);
  // The tenant can come from the secret's TenantId field, else the client's primary domain works
  // as a tenant hint for the token endpoint.
  const tenant = pickField(resolved.fields, M365_TENANT_FIELDS) ?? client.primaryDomain;
  if (!appId || !secret || !tenant) return NextResponse.json({ error: "the m365-admin secret is missing app id / client secret / tenant fields (must be an app registration)" }, { status: 409 });

  const result = await listTenantDomains(tenant, appId, secret);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });

  await recordAudit("client.domains.refresh", { user: _g.user, clientId: client.id, detail: { count: result.domains.length } });
  return NextResponse.json({
    domains: result.domains, // [{ name, isDefault, isVerified }]
    selected: client.domains, // what the client currently offers
    defaultDomain: client.emailDomain ?? client.primaryDomain,
  });
}
