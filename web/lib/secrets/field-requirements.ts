// What FIELDS each kind of credential must carry for its runner connector to actually authenticate.
// Keyed by the secret NAME the systems reference (the same name the runner resolves via $creds[name]).
// Each requirement is satisfied if ANY of its synonyms is present among the secret's Delinea fields
// (case/space-insensitive) — the synonym lists mirror the runner's own field-picking in
// Start-IamRunner.ps1, so "Test" catches the exact misconfig the runner would otherwise throw on
// ("the secret has no TenantId field", "mimecast needs a CLIENT ID + CLIENT SECRET", …).
//
// Extensible: add a row for a new provider's secret name. An unknown name has no rule (no warning).
// `orClientDomain` requirements are satisfied either by a matching field OR by the client having a
// primary domain (the runner falls back to it) — so they don't false-flag a correctly-set secret.
export type FieldReq = { label: string; anyOf: string[]; orClientDomain?: boolean };

export const SECRET_FIELD_REQUIREMENTS: Record<string, FieldReq[]> = {
  // M365 admin (Graph): username + password + a tenant hint (tenant can come from the client domain).
  "m365-admin": [
    { label: "admin username", anyOf: ["Username"] },
    { label: "admin password", anyOf: ["Password"] },
    { label: "tenant id / domain", anyOf: ["TenantId", "Tenant", "Domain"], orClientDomain: true },
  ],
  // Exchange Online: app-only certificate auth — AppId (stored as the secret username) + thumbprint.
  exchange: [
    { label: "app id (username)", anyOf: ["Username", "AppId", "Application ID", "ClientId", "ClientID"] },
    { label: "certificate thumbprint", anyOf: ["CertificateThumbprint", "Certificate Thumbprint", "Thumbprint"] },
  ],
  // On-prem Exchange: a remote PowerShell connection uri/server + a credential.
  "exchange-onprem": [
    { label: "connection uri / server", anyOf: ["ConnectionUri", "Connection Uri", "Server", "Uri", "URL"] },
    { label: "username", anyOf: ["Username"] },
    { label: "password", anyOf: ["Password"] },
  ],
  // Mimecast API 2.0 application: client id + client secret.
  mimecast: [
    { label: "client id", anyOf: ["ClientID", "ClientId", "Client ID", "AppId", "Application ID", "Username"] },
    { label: "client secret", anyOf: ["ClientSecret", "Client Secret", "Secret", "API Key", "ApiKey", "AccessToken", "Token", "Password"] },
  ],
  // Spanning Backup — synonym lists MIRROR the runner's Use-CtgSpanningSecret $pick exactly (so the
  // check can't disagree with what actually connects). The api user falls back to the client domain;
  // the endpoint can be a full URL (apiURL/BaseUrl/Url) OR a Region.
  spanning: [
    { label: "account / api user", anyOf: ["ClientID", "ClientId", "Client ID", "Domain", "AccountID", "AccountId", "Account", "Tenant", "Username"], orClientDomain: true },
    { label: "api token", anyOf: ["ClientSecret", "AccessToken", "Access Token", "ApiToken", "API Key", "APIKey", "Api Key", "ApiKey", "Token", "Key", "Password"] },
    { label: "region or base url", anyOf: ["apiURL", "ApiUrl", "ApiURL", "BaseUrl", "Base URL", "Url", "URL", "Region"] },
  ],
  // On-prem AD / directory-sync service account: username + password + the DC to bind to.
  "ad-dc": [
    { label: "username", anyOf: ["Username"] },
    { label: "password", anyOf: ["Password"] },
    { label: "domain controller (server)", anyOf: ["Server", "Host", "DomainController", "DC"] },
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

// Which required fields a secret is MISSING for its provider. `presentFields` = the secret's Delinea
// field NAMES (never values). `clientHasTenantHint` lets the m365 tenant requirement pass when the
// client's primary domain supplies the tenant instead of a secret field. Unknown secret name → no
// rule → nothing missing.
export function checkFieldShape(
  secretName: string,
  presentFields: string[],
  opts: { clientHasTenantHint?: boolean } = {}
): { ok: boolean; missing: string[] } {
  const reqs = SECRET_FIELD_REQUIREMENTS[secretName];
  if (!reqs) return { ok: true, missing: [] };
  const have = new Set(presentFields.map(norm));
  const missing = reqs
    .filter((r) => {
      // Some requirements (m365 tenant, spanning user) can be supplied by the client's primary domain.
      if (r.orClientDomain && opts.clientHasTenantHint) return false;
      return !r.anyOf.some((syn) => have.has(norm(syn)));
    })
    .map((r) => r.label);
  return { ok: missing.length === 0, missing };
}
