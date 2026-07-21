// Test a credential's RAW FIELD VALUES before they're written to Delinea — the "confirm it's working"
// step in the guided setup, so the app only creates a vault secret from credentials that actually work.
//
// This is a registry keyed by secretName: adding a system = adding one entry. Two kinds of prover:
//
//   BLOCKING (live)  — the app can prove the credential itself is good/bad from here (M365: run the
//                      exact OAuth client-credentials grant the runner uses). A failure REFUSES the
//                      write — there's no point vaulting a credential we just proved can't authenticate.
//   ADVISORY (agent) — the app CAN'T reach the target (on-prem AD), so the pre-write check is whether
//                      the client's own runner is reachable + capable. A failure is surfaced but does
//                      NOT block the write: the secret must exist in Delinea before the runner can do
//                      the real bind (validated by the connection test that runs after the write).
//
// Values are used only to produce a verdict — never returned, never logged. The module is DB-free: the
// ad-dc agent check is injected as `ctx.agentReach` so the pure registry unit-tests without Prisma.
import {
  classifyM365Credential,
  pickField,
  M365_APPID_FIELDS,
  M365_SECRET_FIELDS,
  M365_TENANT_FIELDS,
  probeEntraClientCredentials,
} from "@/lib/secrets/m365-credential";
import { keyPemFromBase64Json, probeGoogleDirectory } from "@/lib/secrets/google-verify";

export type ValueProbe = {
  probeable: boolean; // is there a prover for this secret? false → caller writes, runner verifies later
  blocking: boolean; // should a failed probe REFUSE the vault write?
  ok?: boolean; // verdict — present only when probeable
  error?: string; // why it failed (operator-facing)
  hint?: string; // one-line remediation, when we have one
  label?: string; // short success summary
  kind?: "live" | "agent"; // how it was tested — drives the UI copy
};

// Injected context so this module stays DB-free and pure-testable.
export type ProbeCtx = {
  clientPrimaryDomain?: string; // fallback tenant for m365 when the secret carries no TenantId/Domain
  // For ad-dc: "is the client's own AD-capable runner reachable right now" (from clientRunnerReachability).
  agentReach?: () => Promise<{ servable: boolean; reason?: string }>;
};

type Prober = (values: Record<string, string>, ctx: ProbeCtx, fetcher: typeof fetch) => Promise<ValueProbe>;

// Mirrors field-requirements.ts's "google-admin" anyOf lists (ClientSecret/apiURL requirements).
const GOOGLE_KEY_FIELDS = ["ClientSecret", "Client Secret", "Secret", "ApiKey", "Key"];
const GOOGLE_IMPERSONATE_FIELDS = ["apiURL", "ApiUrl", "ApiURL", "Url", "URL"];

const MIMECAST_ID_FIELDS = ["ClientID", "ClientId", "Client ID", "AppId", "Application ID", "Username"];
const MIMECAST_SECRET_FIELDS = ["ClientSecret", "Client Secret", "Secret", "API Key", "ApiKey", "AccessToken", "Token", "Password"];
const SPANNING_ID_FIELDS = ["ClientID", "ClientId", "Client ID", "Domain", "AccountID", "AccountId", "Account", "Tenant", "Username"];
const SPANNING_TOKEN_FIELDS = ["ClientSecret", "AccessToken", "Access Token", "ApiToken", "APIKey", "Api Key", "ApiKey", "Token", "Key", "Password"];
const SPANNING_REGION_FIELDS = ["apiURL", "ApiUrl", "ApiURL", "BaseUrl", "Base URL", "Url", "URL", "Region"];
const PROOFPOINT_USER_FIELDS = ["X-User", "Username", "AdminUser", "Admin", "Email", "User"];
const PROOFPOINT_PASS_FIELDS = ["X-Password", "Password", "AdminPassword", "Secret", "ApiKey", "API Key", "Token"];
const PROOFPOINT_DOMAIN_FIELDS = ["Domain", "OrgDomain", "Org", "Tenant"];
const PROOFPOINT_REGION_FIELDS = ["Region", "apiURL", "ApiUrl", "BaseUrl", "Base URL", "Url", "URL"];

// Spanning region -> API base. A full URL in the region field wins; else map the short region.
// Mirrors Connect-CtgSpanning's normalization: force https, and append /external when the stored
// value is just the host (the guided setup vaults "https://<service>-api-<region>.spanningbackup.com"
// and the runner appends /external the same way — without this the probe would 404 a good credential).
function spanningBase(region: string): string {
  const v = (region || "us").trim();
  if (/^https?:\/\//i.test(v)) {
    let u = v.replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
    if (!/\/(external|api\/v\d+)$/i.test(u)) u += "/external";
    return u;
  }
  return `https://o365-api-${v.toLowerCase()}.spanningbackup.com/external`;
}
// Proofpoint region -> API base. A full URL wins; else map us1..us5/eu1/au1.
function proofpointBase(region: string): string | null {
  const v = (region || "").trim();
  if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, "") + (/\/api\/v1$/.test(v) ? "" : "/api/v1");
  if (/^(us[1-5]|eu1|au1)$/i.test(v)) return `https://${v.toLowerCase()}.proofpointessentials.com/api/v1`;
  return null;
}

const PROBERS: Record<string, Prober> = {
  // M365 admin — the definitive live test: the same client-credentials grant Connect-CtgM365 runs. A
  // Global-Admin account (UPN username) is caught before we even hit the network (it can NEVER work).
  "m365-admin": async (values, ctx, fetcher) => {
    const appId = pickField(values, M365_APPID_FIELDS);
    const secret = pickField(values, M365_SECRET_FIELDS);
    if (!appId || !secret) {
      return { probeable: true, blocking: true, ok: false, error: `missing ${!appId ? "app id (Username/appID)" : "client secret (Password/Secret)"}` };
    }
    const cls = classifyM365Credential(values);
    if (cls.kind === "user-account") {
      return {
        probeable: true,
        blocking: true,
        ok: false,
        error: cls.reason,
        hint: "use an app registration's app id (a GUID) + its client secret, not a Global Admin sign-in",
        kind: "live",
      };
    }
    const tenant = pickField(values, M365_TENANT_FIELDS) ?? (ctx.clientPrimaryDomain?.trim() || undefined);
    if (!tenant) {
      return { probeable: true, blocking: true, ok: false, error: "no tenant id/domain, and the client has no primary domain to fall back on", kind: "live" };
    }
    const p = await probeEntraClientCredentials(tenant, appId, secret, fetcher);
    return p.ok
      ? { probeable: true, blocking: true, ok: true, label: "authenticated against Entra", kind: "live" }
      : { probeable: true, blocking: true, ok: false, error: p.error ?? "authentication failed", hint: p.hint, kind: "live" };
  },

  // Google Workspace service account — the definitive live test: the same DWD JWT-bearer grant +
  // Directory API read probeGoogleDirectory runs. Blocking: there's no point vaulting a key we just
  // proved can't impersonate the tenant's super admin. Fields mirror field-requirements.ts's
  // "google-admin" entry — the key lives in ClientSecret, the impersonate target in apiURL.
  "google-admin": async (values, _ctx, fetcher) => {
    const keyBase64 = pickField(values, GOOGLE_KEY_FIELDS);
    const impersonate = pickField(values, GOOGLE_IMPERSONATE_FIELDS);
    if (!keyBase64 || !impersonate) {
      return {
        probeable: true,
        blocking: true,
        ok: false,
        error: `missing ${!keyBase64 ? "service-account key (ClientSecret)" : "impersonate email (apiURL)"}`,
      };
    }
    if (!keyPemFromBase64Json(keyBase64)) {
      return { probeable: true, blocking: true, ok: false, error: "invalid service account key file (not base64 JSON, or missing client_email/private_key)", kind: "live" };
    }
    const p = await probeGoogleDirectory({ keyBase64, impersonate, fetcher });
    return p.ok
      ? { probeable: true, blocking: true, ok: true, label: "authenticated against Google Directory", kind: "live" }
      : { probeable: true, blocking: true, ok: false, error: p.error ?? "authentication failed", kind: "live" };
  },

  // On-prem AD service account — the app can't bind AD, so the pre-write check is runner comms: is the
  // client's own AD-capable agent online? Advisory (does not block the write). Without an injected
  // reachability probe there's nothing to test → not probeable.
  "ad-dc": async (_values, ctx) => {
    if (!ctx.agentReach) return { probeable: false, blocking: false };
    const r = await ctx.agentReach();
    return r.servable
      ? { probeable: true, blocking: false, ok: true, label: "the client's AD agent is online and capable", kind: "agent" }
      : { probeable: true, blocking: false, ok: false, error: r.reason ?? "no capable AD agent is online for this client", kind: "agent" };
  },

  // Mimecast API 2.0 — the exact OAuth2 client-credentials grant Connect-CtgMimecast runs.
  "mimecast": async (values, _ctx, fetcher) => {
    const id = pickField(values, MIMECAST_ID_FIELDS);
    const secret = pickField(values, MIMECAST_SECRET_FIELDS);
    if (!id || !secret) return { probeable: true, blocking: true, ok: false, error: `missing ${!id ? "client id" : "client secret"}`, kind: "live" };
    try {
      const res = await fetcher("https://api.services.mimecast.com/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
      return res.ok && body.access_token
        ? { probeable: true, blocking: true, ok: true, label: "authenticated to Mimecast (API 2.0)", kind: "live" }
        : { probeable: true, blocking: true, ok: false, error: body.error_description ?? body.error ?? `Mimecast token request failed (${res.status})`, hint: "check the 2.0 app's Client ID + Client Secret", kind: "live" };
    } catch (e) { return { probeable: true, blocking: true, ok: false, error: (e as Error).message, kind: "live" }; }
  },
  // Spanning Backup API — Basic auth (client id : token) against the region base.
  "spanning": async (values, _ctx, fetcher) => {
    const id = pickField(values, SPANNING_ID_FIELDS);
    const token = pickField(values, SPANNING_TOKEN_FIELDS);
    if (!id || !token) return { probeable: true, blocking: true, ok: false, error: `missing ${!id ? "login email" : "api token"}`, kind: "live" };
    const base = spanningBase(pickField(values, SPANNING_REGION_FIELDS) ?? "us");
    const auth = "Basic " + Buffer.from(`${id}:${token}`).toString("base64");
    try {
      const res = await fetcher(`${base}/users?limit=1`, { headers: { Authorization: auth, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      return res.ok
        ? { probeable: true, blocking: true, ok: true, label: "authenticated to Spanning", kind: "live" }
        : { probeable: true, blocking: true, ok: false, error: `Spanning returned ${res.status}`, hint: "check the API user + token and the region", kind: "live" };
    } catch (e) { return { probeable: true, blocking: true, ok: false, error: (e as Error).message, kind: "live" }; }
  },
  // Proofpoint Essentials — X-User/X-Password against /orgs/{domain}. Needs a region (see Task 2);
  // without one we can't build the base URL, so it's advisory (never a false red) — the runner test verifies.
  "proofpoint": async (values, ctx, fetcher) => {
    const user = pickField(values, PROOFPOINT_USER_FIELDS);
    const pass = pickField(values, PROOFPOINT_PASS_FIELDS);
    const domain = pickField(values, PROOFPOINT_DOMAIN_FIELDS) ?? (ctx.clientPrimaryDomain?.trim() || undefined);
    const base = proofpointBase(pickField(values, PROOFPOINT_REGION_FIELDS) ?? "");
    if (!base) return { probeable: false, blocking: false };
    if (!user || !pass) return { probeable: true, blocking: true, ok: false, error: `missing ${!user ? "admin email (X-User)" : "admin password (X-Password)"}`, kind: "live" };
    if (!domain) return { probeable: true, blocking: true, ok: false, error: "no org domain, and the client has no primary domain to fall back on", kind: "live" };
    try {
      const res = await fetcher(`${base}/orgs/${encodeURIComponent(domain)}/settings/azure`, { headers: { "X-User": user, "X-Password": pass }, signal: AbortSignal.timeout(20_000) });
      return res.ok
        ? { probeable: true, blocking: true, ok: true, label: "authenticated to Proofpoint Essentials", kind: "live" }
        : { probeable: true, blocking: true, ok: false, error: `Proofpoint returned ${res.status}`, hint: "check the admin email/password, the org domain, and the region", kind: "live" };
    } catch (e) { return { probeable: true, blocking: true, ok: false, error: (e as Error).message, kind: "live" }; }
  },
};

// Is there a prover for this secret at all? (Lets the UI decide whether to show a "Test" affordance
// before the create call, without invoking the probe.)
export function isProbeable(secretName: string): boolean {
  return secretName in PROBERS;
}

// Run the prover for a secret over its raw field values. Unknown secret → { probeable:false } so the
// caller writes and lets the runner connection test verify it later.
export async function probeSecretValues(
  secretName: string,
  values: Record<string, string>,
  ctx: ProbeCtx = {},
  fetcher: typeof fetch = fetch,
): Promise<ValueProbe> {
  const prober = PROBERS[secretName];
  if (!prober) return { probeable: false, blocking: false };
  return prober(values, ctx, fetcher);
}
