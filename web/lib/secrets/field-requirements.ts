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
// `hint` is a one-line "where do I get this" shown under the field in the guided setup's create form —
// inline guidance in place of screenshots (which would go stale per vendor and per client). Optional:
// a field with no hint just renders its synonym examples.
export type FieldReq = { label: string; anyOf: string[]; orClientDomain?: boolean; optional?: boolean; hint?: string };

export const SECRET_FIELD_REQUIREMENTS: Record<string, FieldReq[]> = {
  // M365 admin (Graph app registration): an app id + a client secret + a tenant hint (the tenant can
  // come from the client's domain). Connect-CtgM365 uses -ClientSecretCredential, where UserName IS
  // the app id and Password IS the client secret.
  //
  // The synonyms MIRROR the runner's CRED_USERNAME_FIELDS/CRED_PASSWORD_FIELDS exactly: Delinea's
  // "Entra Azure AD Account" template calls them Username/Password, while "Automation - Azure App"
  // calls the same pair appID/Secret. If this list and the runner's ever diverge, the Test goes green
  // on a credential the runner can't use (or red on one it can) — keep them in lockstep.
  "m365-admin": [
    { label: "admin username / app id", anyOf: ["Username", "appID", "AppId", "ApplicationId", "ClientId"], hint: "Entra admin → App registrations → your app → Overview → Application (client) ID (a GUID, not a person's login)" },
    { label: "admin password / client secret", anyOf: ["Password", "Secret", "ClientSecret", "AppSecret"], hint: "the app registration → Certificates & secrets → New client secret → copy the Value (shown once)" },
    { label: "tenant id / domain", anyOf: ["TenantId", "Tenant", "Domain"], orClientDomain: true, hint: "same Overview page → Directory (tenant) ID; or leave blank to use the client's primary domain" },
  ],
  // Exchange Online: app-only certificate auth — AppId (the secret username) + a cert. The cert is
  // either a Windows-store thumbprint OR a base64 .pfx (cross-platform: macOS/Linux central runners).
  exchange: [
    { label: "app id (username)", anyOf: ["Username", "AppId", "Application ID", "ClientId", "ClientID"], hint: "the Exchange Online app registration → Application (client) ID (app-only cert auth, not a password)" },
    { label: "certificate (thumbprint or .pfx)", anyOf: ["CertificateThumbprint", "Certificate Thumbprint", "Thumbprint", "CertificateBase64", "CertificatePfxBase64"], hint: "the cert thumbprint uploaded to the app registration — or a base64 .pfx for cross-platform central runners" },
  ],
  // On-prem Exchange: a remote PowerShell connection uri/server + a credential.
  "exchange-onprem": [
    { label: "connection uri / server", anyOf: ["ConnectionUri", "Connection Uri", "Server", "Uri", "URL"], hint: "the on-prem Exchange PowerShell endpoint, e.g. http://<exch-host>/PowerShell/" },
    { label: "username", anyOf: ["Username"], hint: "an Exchange admin service account (DOMAIN\\user)" },
    { label: "password", anyOf: ["Password"], hint: "that service account's password" },
  ],
  // Adobe UMAPI v2 (OAuth Server-to-Server): Client ID + Client Secret + the organization id.
  // Synonyms MIRROR the runner's Use-CtgAdobeSecret pick lists. The org id has no home in Delinea's
  // stock "Automation - API" template (clientID / ClientSecret / accountid / apiURL — no OrgId), so
  // `accountid` is where it actually lives; the runner also finds it by value shape (…@AdobeOrg) in
  // any field, but this check is name-based, so the name list has to include accountid or a
  // correctly-wired secret would read as "missing a field" here.
  //
  // NOT required and deliberately absent: an access token (the runner mints a short-lived one per
  // connect), the scopes (fixed: openid,AdobeID,user_management_sdk), and a technical-account
  // id/email (those belong to Adobe's deprecated Service Account JWT flow, which this does not use).
  adobe: [
    { label: "client id", anyOf: ["ClientId", "ClientID", "Client ID", "Username"], hint: "Adobe Developer Console → your project → the Server-to-Server credential → Client ID" },
    { label: "client secret", anyOf: ["ClientSecret", "Client Secret", "Secret", "ApiKey", "Key", "Password"], hint: "same credential → Client Secret (Retrieve client secret)" },
    { label: "org id (…@AdobeOrg)", anyOf: ["OrgId", "OrgID", "Org ID", "Org", "OrganizationId", "OrganizationID", "Organization ID", "accountid", "AccountId", "AccountID", "Account ID", "Account"], hint: "same credential → Organization ID, ends in @AdobeOrg" },
  ],
  // Mimecast API 2.0 application: client id + client secret.
  mimecast: [
    { label: "client id", anyOf: ["ClientID", "ClientId", "Client ID", "AppId", "Application ID", "Username"], hint: "Mimecast Administration Console → Services → API and Platform Integrations → your 2.0 app → Client ID" },
    { label: "client secret", anyOf: ["ClientSecret", "Client Secret", "Secret", "API Key", "ApiKey", "AccessToken", "Token", "Password"], hint: "same app → Client Secret (generated with the app; regenerate if lost)" },
  ],
  // Spanning Backup — synonym lists MIRROR the runner's Use-CtgSpanningSecret $pick exactly (so the
  // check can't disagree with what actually connects). The api user falls back to the client domain;
  // the endpoint can be a full URL (apiURL/BaseUrl/Url) OR a Region.
  spanning: [
    { label: "account / api user", anyOf: ["ClientID", "ClientId", "Client ID", "Domain", "AccountID", "AccountId", "Account", "Tenant", "Username"], orClientDomain: true, hint: "the tenant/domain the Spanning API key was issued for; or leave blank to use the client's primary domain" },
    { label: "api token", anyOf: ["ClientSecret", "AccessToken", "Access Token", "ApiToken", "API Key", "APIKey", "Api Key", "ApiKey", "Token", "Key", "Password"], hint: "Spanning admin console → Settings → API Token (generate one for this tenant)" },
    { label: "region or base url", anyOf: ["apiURL", "ApiUrl", "ApiURL", "BaseUrl", "Base URL", "Url", "URL", "Region"], hint: "the tenant's Spanning region — us, eu, ap, or ca (or the full api-<region>.spanningbackup.com URL)" },
  ],
  // Slack SCIM: a single Bearer token carrying the `admin` scope, generated by a Slack Owner/Admin.
  // Synonyms MIRROR the runner's Use-CtgSlackSecret pick list (the secret's own Password field is a
  // legitimate place for a token, so it's accepted last). SCIM also needs a Business+/Enterprise Grid
  // plan — that can't be checked from the field names, so the connection test names it instead.
  slack: [
    { label: "SCIM token (admin scope)", anyOf: ["Token", "ApiToken", "API Token", "AccessToken", "Access Token", "ApiKey", "API Key", "SCIMToken", "SCIM Token", "Password"] },
  ],
  // Spanning ADMIN CONSOLE sign-in — the credential the browser force-sync signs in WITH. The console
  // is Microsoft 365 SSO, so this is an interactive M365 admin login (an email + that account's
  // password), NOT the API clientId/secret above: handing an API key to Microsoft's sign-in box cannot
  // authenticate, and repeated attempts walk a real admin account toward smart lockout (the runner
  // refuses it outright — see Invoke-CtgSpanningForceSync).
  //
  // It is a SEPARATE secret from `spanning` on purpose. Licensing (both lanes) is pure API and never
  // needs this, so a client without a portal login stays fully ready; and an M365 password can never
  // end up in the API secret's Username/Password, where Use-CtgSpanningSecret would send it to Spanning
  // as clientId:clientSecret and 401 every licensing call.
  //
  // MFA: enable One-Time Password on the Delinea secret — the runner mints the code AT the prompt, so
  // the seed never leaves the vault. It must be a TOTP/software token; push or phone-call MFA can't be
  // automated and the sign-in will simply time out at the prompt.
  //
  // Synonyms mirror the runner's pick order in Invoke-CtgSpanningForceSync (Portal* first, then the
  // generic pair — on a dedicated secret the generic Username/Password are the natural fields).
  "spanning-portal": [
    { label: "M365 admin email", anyOf: ["Username", "PortalUsername", "AdminUser", "AdminEmail", "Email", "User"] },
    { label: "that account's password", anyOf: ["Password", "PortalPassword", "AdminPassword"] },
  ],
  // Proofpoint Essentials API: admin email + password (sent as X-User / X-Password). The org domain
  // for the /orgs/{domain} path is satisfied by a Domain field OR the client's primary domain.
  proofpoint: [
    { label: "admin email (X-User)", anyOf: ["X-User", "Username", "AdminUser", "Admin", "Email", "User"], hint: "a Proofpoint Essentials admin login with API access enabled for this org" },
    { label: "admin password (X-Password)", anyOf: ["X-Password", "Password", "AdminPassword", "Secret", "ApiKey", "API Key", "Token"], hint: "that admin account's password" },
    { label: "org domain", anyOf: ["Domain", "OrgDomain", "Org", "Tenant"], orClientDomain: true, hint: "the org's primary domain (the /orgs/{domain} path); or leave blank to use the client's primary domain" },
  ],
  // On-prem AD / directory-sync service account. The common topology is an agent running ON the domain
  // controller, where the runner authenticates as its OWN identity (SYSTEM = the directory's SYSTEM
  // principal) and never uses this credential at all — New-CtgAdConnection (Start-IamRunner.ps1) tries
  // ambient first there and keeps the credential only as a fallback. So username + password are still
  // required (they carry the member-server topology, and are the fallback everywhere else), but two
  // fields are optional:
  //
  //   server — the DC to bind to. Omitted entirely on a DC, where the cmdlets target the local domain.
  //     The "Active Directory Account" Delinea template has no Server field, so the runner reads the DC
  //     name from the Documentation Link field; the synonyms below mirror the runner exactly so the
  //     Test agrees with it.
  //   domain — what QUALIFIES a bare username. That template keeps the domain in its own field, so the
  //     stored username is usually a bare sAMAccountName — and a bare name has no realm, so it cannot
  //     get a Kerberos ticket, degrades to NTLM, and a DC with LDAP signing / channel binding enforced
  //     refuses the bind. The runner qualifies it from this field. Listed (optional) so the Test SHOWS
  //     the field exists: a username already written as DOMAIN\user or user@domain needs no Domain.
  //
  // `optional` => a missing field never flags as missing.
  "ad-dc": [
    { label: "username", anyOf: ["Username"], hint: "an AD service account with rights to create/disable users (DOMAIN\\user or user@domain)" },
    { label: "password", anyOf: ["Password"], hint: "that service account's password" },
    {
      label: "domain controller (server)",
      anyOf: ["Server", "Host", "DomainController", "DC", "Documentation Link", "DocumentationLink", "Document Link", "DocLink"],
      optional: true,
      hint: "the DC hostname to bind to; leave blank when the agent runs ON a domain controller",
    },
    {
      label: "domain (qualifies a bare username)",
      anyOf: ["Domain", "DomainName", "NetBIOSName", "DNSDomainName", "FQDN"],
      optional: true,
      hint: "needed only if the username has no realm (a bare sAMAccountName)",
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
