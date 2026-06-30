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
// `optional` requirements are recommended-but-not-required: the runner has a safe fallback when the
// field is absent (e.g. an on-DC agent binds to its local domain with no -Server), so the Test must
// NOT report them as missing. They stay in the list to document the field the connector will USE if
// present and to keep the synonym lists honest about what the runner reads.
export type FieldReq = { label: string; anyOf: string[]; orClientDomain?: boolean; optional?: boolean };

export const SECRET_FIELD_REQUIREMENTS: Record<string, FieldReq[]> = {
  // M365 admin (Graph): username + password + a tenant hint (tenant can come from the client domain).
  "m365-admin": [
    { label: "admin username", anyOf: ["Username"] },
    { label: "admin password", anyOf: ["Password"] },
    { label: "tenant id / domain", anyOf: ["TenantId", "Tenant", "Domain"], orClientDomain: true },
  ],
  // Exchange Online: app-only certificate auth — AppId (the secret username) + a cert. The cert is
  // either a Windows-store thumbprint OR a base64 .pfx (cross-platform: macOS/Linux central runners).
  exchange: [
    { label: "app id (username)", anyOf: ["Username", "AppId", "Application ID", "ClientId", "ClientID"] },
    { label: "certificate (thumbprint or .pfx)", anyOf: ["CertificateThumbprint", "Certificate Thumbprint", "Thumbprint", "CertificateBase64", "CertificatePfxBase64"] },
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
  // On-prem AD / directory-sync service account: username + password are required; the DC to bind to
  // is OPTIONAL. The common topology is an agent running ON the domain controller, which authenticates
  // in its ambient/local domain context — so New-CtgAdConnection (Start-IamRunner.ps1) OMITS -Server
  // entirely and the AD cmdlets target the local DC. When a target IS wanted (an agent on a different
  // in-network box), the "Active Directory Account" Delinea template has no Server field, so the runner
  // reads the DC name from the Documentation Link field — the synonyms below mirror that exactly so the
  // Test agrees with the runner. `optional` => a missing server field never flags as missing.
  "ad-dc": [
    { label: "username", anyOf: ["Username"] },
    { label: "password", anyOf: ["Password"] },
    {
      label: "domain controller (server)",
      anyOf: ["Server", "Host", "DomainController", "DC", "Documentation Link", "DocumentationLink", "Document Link", "DocLink"],
      optional: true,
    },
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
      // Optional requirements (the runner has a safe fallback, e.g. on-DC ambient auth) never flag.
      if (r.optional) return false;
      // Some requirements (m365 tenant, spanning user) can be supplied by the client's primary domain.
      if (r.orClientDomain && opts.clientHasTenantHint) return false;
      return !r.anyOf.some((syn) => have.has(norm(syn)));
    })
    .map((r) => r.label);
  return { ok: missing.length === 0, missing };
}
