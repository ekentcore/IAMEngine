// Is an m365-admin secret an APP REGISTRATION, or a human USER ACCOUNT?
//
// This distinction is invisible to a field-NAME check and fatal at run time. Connect-CtgM365 connects
// with -ClientSecretCredential — the OAuth client-credentials flow — where UserName must be the
// application (client) ID and Password the app's client secret. A Global Admin's own username and
// password cannot authenticate that way no matter how correct they are: Entra rejects them with
// AADSTS700016 / unauthorized_client.
//
// Both shapes carry a "Username" and a "Password" field, so `checkFieldShape` (which only sees field
// NAMES) passes a GA account happily. Only the VALUE's shape tells them apart:
//
//   app registration  Username = 8d5e...-...-...  (a GUID — the app id)
//   user account      Username = admin@client.com (a UPN — a person)
//
// We look at the value only to classify it, and return nothing but the verdict — never the value.

export type M365CredKind = "app-registration" | "user-account" | "incomplete";
export type M365CredVerdict = { kind: M365CredKind; reason: string; missing?: string[] };

const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

// Case/space-insensitive field pick — mirrors the runner's Select-CtgCredField synonym lists.
export function pickField(fields: Record<string, string>, names: string[]): string | undefined {
  return pick(fields, names);
}

function pick(fields: Record<string, string>, names: string[]): string | undefined {
  const lower = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, ""), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase().replace(/\s+/g, ""));
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return undefined;
}

export const M365_APPID_FIELDS = ["Username", "appID", "AppId", "ApplicationId", "ClientId"];
export const M365_SECRET_FIELDS = ["Password", "Secret", "ClientSecret", "AppSecret"];
export const M365_TENANT_FIELDS = ["TenantId", "Tenant", "DirectoryId", "Domain"];

export function classifyM365Credential(fields: Record<string, string>): M365CredVerdict {
  const appId = pick(fields, M365_APPID_FIELDS);
  const secret = pick(fields, M365_SECRET_FIELDS);
  const tenant = pick(fields, M365_TENANT_FIELDS);

  const missing: string[] = [];
  if (!appId) missing.push("app id (Username/appID)");
  if (!secret) missing.push("client secret (Password/Secret)");
  if (missing.length) return { kind: "incomplete", reason: `missing ${missing.join(" and ")}`, missing };

  // The decisive test: a UPN/email is a person, a GUID is an application.
  if (appId!.includes("@")) {
    return {
      kind: "user-account",
      reason: "the username is a UPN (a person), not an application id — this is a Global Admin account, and the client-credentials flow the runner uses cannot authenticate with it",
    };
  }
  if (!GUID.test(appId!)) {
    return {
      kind: "user-account",
      reason: "the username is not an application id (GUID) — the client-credentials flow the runner uses needs an app registration's app id",
    };
  }
  if (!tenant) {
    return { kind: "incomplete", reason: "app id + secret look right but there is no TenantId/Domain field, and the client has no primary domain to fall back on", missing: ["tenant id"] };
  }
  return { kind: "app-registration", reason: "app id (GUID) + client secret + tenant — the shape Connect-CtgM365 needs" };
}

// --- The definitive test: actually authenticate -------------------------------------------------
// The shape check above is free and catches the common case, but only Entra can say whether a
// credential really works. This performs the SAME client-credentials grant the runner's
// Connect-MgGraph -ClientSecretCredential performs, so a pass here means the runner will connect.
//
// No runner and no Graph SDK needed — one HTTPS POST. The credential is used, never logged; only the
// verdict and Entra's own error code come back.
export type EntraProbe = { ok: boolean; error?: string; errorCode?: string; hint?: string };

// Entra error codes worth translating into an operator-actionable sentence.
const HINTS: Record<string, string> = {
  AADSTS7000215: "the client secret is wrong or expired — rotate it in the app registration and update the Delinea secret",
  AADSTS700016: "no application with that app id exists in this tenant — the app id or the tenant is wrong",
  AADSTS900023: "the tenant id/domain is not a real tenant",
  AADSTS7000218: "the app id is a USER, not an application — this credential is a Global Admin account, not an app registration",
  AADSTS50034: "that username is a user account, not an app registration — the client-credentials flow needs an app id",
  unauthorized_client: "the app exists but is not authorized for the client-credentials flow",
};

export async function probeEntraClientCredentials(
  tenant: string,
  appId: string,
  clientSecret: string,
  fetcher: typeof fetch = fetch
): Promise<EntraProbe> {
  // The probe only reports a verdict, so drop the token the grant handed back.
  const { token: _token, ...verdict } = await acquireGraphToken(tenant, appId, clientSecret, fetcher);
  return verdict;
}

// The same grant, but keeps the access token — for callers that go on to READ from Graph (the fleet
// permission audit, the leaked-seat scan). Separate function rather than an option on the probe so
// the probe's contract stays "verdict only, never a credential or a token".
export type GraphTokenResult = EntraProbe & { token?: string };

export async function acquireGraphToken(
  tenant: string,
  appId: string,
  clientSecret: string,
  fetcher: typeof fetch = fetch
): Promise<GraphTokenResult> {
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });
    const res = await fetcher(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const d = (await res.json().catch(() => null)) as { access_token?: string } | null;
      return { ok: true, token: d?.access_token };
    }
    const d = (await res.json().catch(() => null)) as { error?: string; error_description?: string } | null;
    // error_description embeds the AADSTS code and echoes request ids/timestamps — pull just the code.
    const code = d?.error_description?.match(/AADSTS\d+/)?.[0] ?? d?.error ?? `HTTP ${res.status}`;
    return { ok: false, errorCode: code, error: d?.error ?? `HTTP ${res.status}`, hint: HINTS[code] ?? HINTS[d?.error ?? ""] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
