// Self-grant: bring a client's m365-admin app registration up to spec WITHOUT a Global Admin sign-in,
// by leveraging an over-permission it already holds. If the app carries AppRoleAssignment.ReadWrite.All
// (the escalation role the connection test flags as "Extra Access — risk"), an app-only token minted
// from the app's own credential can assign the missing Graph app roles to its own service principal —
// the exact operation that role authorizes. This never removes the surplus roles (they stay flagged
// like today); it only uses one of them to close the gaps.
//
// All web-side: provisioning is already web-side Graph HTTP (provision-m365-app.ts), so this reuses the
// same appRoleAssignedTo POST with an app-only token instead of a device-code Global-Admin token.
import {
  acquireGraphToken,
  classifyM365Credential,
  pickField,
  M365_APPID_FIELDS,
  M365_SECRET_FIELDS,
  M365_TENANT_FIELDS,
} from "./m365-credential";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken, resolveSecretFields } from "./delinea";
import { graphGet, graphSend, readGrantedAppRoles, type GraphFetch } from "./graph-app-roles";
import { resolveGraphAppRoleIds } from "./provision-m365-app";
import { graphCapGaps, suggestedRole } from "./graph-caps";

// The escalation role that authorizes a service principal to assign app roles (to itself) — the one
// this flow relies on. Matched case-insensitively against the granted role names.
export const SELF_GRANT_ROLE = "AppRoleAssignment.ReadWrite.All";

// Does the granted role set include the self-grant primitive? (Pure — unit-tested.)
export function canSelfGrant(grantedRoles: readonly string[]): boolean {
  const want = SELF_GRANT_ROLE.toLowerCase();
  return grantedRoles.some((r) => r.toLowerCase() === want);
}

// The role NAMES to grant: every REQUIRED capability the app is missing (anyOf-aware via graphCapGaps),
// plus any explicitly-requested optional roles that aren't already granted. Deduped, order-stable.
// (Pure — unit-tested.)
export function rolesToSelfGrant(grantedRoles: readonly string[], optionalRoles: readonly string[] = []): string[] {
  const have = new Set(grantedRoles.map((r) => r.toLowerCase()));
  const requiredMissing = graphCapGaps(grantedRoles).map(suggestedRole);
  const optionalMissing = optionalRoles.filter((r) => !have.has(r.toLowerCase()));
  return [...new Set([...requiredMissing, ...optionalMissing])];
}

export type SelfGrantInput = {
  externalId: string; // the m365-admin Delinea secret id
  primaryDomain: string | null; // tenant fallback when the secret carries no TenantId/Domain
  optionalRoles?: string[]; // optional-cap suggestedRoles to also grant if missing
};

export type SelfGrantResult = {
  ok: boolean;
  reason?: string; // why it couldn't run (surfaced to the operator)
  appId?: string;
  granted?: string[]; // roles newly assigned this run
  alreadyHad?: string[]; // roles Graph reported already present (idempotent no-op)
  failed?: { role: string; error: string }[]; // roles that couldn't be assigned
};

// Grant the missing Graph app roles to the client's m365-admin app using its own AppRoleAssignment
// .ReadWrite.All. Returns a per-role breakdown. Never throws for expected failures — they come back in
// the result so the caller can show them.
export async function selfGrantM365Permissions(input: SelfGrantInput, fetcher: GraphFetch = fetch): Promise<SelfGrantResult> {
  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) return { ok: false, reason: "Delinea is not configured on the app, so the credential can't be resolved" };

  const dToken = await getDelineaToken(cfg).catch(() => null);
  if (!dToken) return { ok: false, reason: "couldn't authenticate to Delinea" };
  const resolved = await resolveSecretFields(cfg, input.externalId, undefined, dToken);
  if (!resolved.ok || !resolved.fields) return { ok: false, reason: `couldn't resolve the m365-admin secret: ${resolved.error ?? "unknown error"}` };

  const kind = classifyM365Credential(resolved.fields);
  if (kind.kind !== "app-registration") {
    return { ok: false, reason: "the m365-admin credential is a Global Admin login, not an app registration — a login can't self-grant; use Set up M365 instead" };
  }
  const appId = pickField(resolved.fields, M365_APPID_FIELDS);
  const secret = pickField(resolved.fields, M365_SECRET_FIELDS);
  const tenant = pickField(resolved.fields, M365_TENANT_FIELDS) ?? input.primaryDomain ?? undefined;
  if (!appId || !secret || !tenant) return { ok: false, reason: "the m365-admin secret is missing the app id, client secret, or tenant" };

  const tok = await acquireGraphToken(tenant, appId, secret, fetcher);
  if (!tok.ok || !tok.token) return { ok: false, reason: tok.hint ?? tok.error ?? "couldn't get an app token" };
  const token = tok.token;

  const grantedRes = await readGrantedAppRoles(token, appId, fetcher);
  if (!grantedRes.ok) return { ok: false, reason: `couldn't read the app's current permissions: ${grantedRes.error ?? "unknown error"}`, appId };
  if (!canSelfGrant(grantedRes.roles)) {
    return { ok: false, reason: `this app doesn't hold ${SELF_GRANT_ROLE}, so it can't grant its own permissions — use Set up M365 (Global Admin) instead`, appId };
  }

  const wanted = rolesToSelfGrant(grantedRes.roles, input.optionalRoles ?? []);
  if (wanted.length === 0) return { ok: true, appId, granted: [], alreadyHad: [], failed: [] };

  const roles = await resolveGraphAppRoleIds(token, fetcher);
  if (!roles.ok) return { ok: false, reason: `couldn't read Microsoft Graph's app roles: ${roles.error}`, appId };

  // The app's OWN service principal object id is the assignment target (principalId). readGrantedAppRoles
  // queries by appId, but the POST needs the SP object id.
  const sp = await graphGet<{ id?: string }>(token, `/servicePrincipals(appId='${encodeURIComponent(appId)}')?$select=id`, fetcher);
  if (!sp.ok || !sp.body.id) return { ok: false, reason: "couldn't find the app's service principal in the tenant", appId };
  const appSpId = sp.body.id;

  const granted: string[] = [];
  const alreadyHad: string[] = [];
  const failed: { role: string; error: string }[] = [];
  for (const name of wanted) {
    const appRoleId = roles.roleIdByName.get(name.toLowerCase());
    if (!appRoleId) { failed.push({ role: name, error: "Microsoft Graph doesn't publish an app role by this name" }); continue; }
    const res = await graphSend(token, "POST", `/servicePrincipals/${roles.graphSpId}/appRoleAssignedTo`, {
      principalId: appSpId,
      resourceId: roles.graphSpId,
      appRoleId,
    }, fetcher);
    if (res.ok) granted.push(name);
    else if (/already|exists|conflict|added object references already exist/i.test(res.error)) alreadyHad.push(name);
    else failed.push({ role: name, error: res.error });
  }

  return { ok: true, appId, granted, alreadyHad, failed };
}
