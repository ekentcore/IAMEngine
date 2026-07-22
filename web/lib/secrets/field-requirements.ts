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
// `unlessAnyPresent` waives a requirement when any of the named fields is present — for a credential
// with two ALTERNATIVE shapes, where one field makes a whole other set moot (e.g. egnyte: a pre-minted
// Token replaces the client_id/secret/account/password the runner would otherwise use to mint one).
// `hint` is a one-line "where do I get this" shown under the field in the guided setup's create form —
// inline guidance in place of screenshots (which would go stale per vendor and per client). Optional:
// a field with no hint just renders its synonym examples.
export type FieldReq = { label: string; anyOf: string[]; orClientDomain?: boolean; optional?: boolean; unlessAnyPresent?: string[]; hint?: string };

// Egnyte access-token synonyms — a long-lived pre-minted bearer token is an alternative to the four
// fields the runner uses to mint one (client_id + client_secret + username + password). Named once so
// the token requirement and each field it waives (via unlessAnyPresent) can't drift apart.
const EGNYTE_TOKEN_SYNONYMS = ["Token", "AccessToken", "Access Token", "ApiToken", "Api Token", "Bearer"];

export const SECRET_FIELD_REQUIREMENTS: Record<string, FieldReq[]> = {
  // M365 admin (Graph app registration): an app id + a client secret + a tenant hint (the tenant can
  // come from the client's domain). Connect-CtgM365 uses -ClientSecretCredential, where UserName IS
  // the app id and Password IS the client secret.
  //
  // The synonyms MIRROR the runner's CRED_USERNAME_FIELDS/CRED_PASSWORD_FIELDS exactly: Delinea's
  // "Entra Azure AD Account" template calls them Username/Password, while "Automation - Azure App"
  // calls the same pair appID/Secret. If this list and the runner's ever diverge, the Test goes green
  // on a credential the runner can't use (or red on one it can) — keep them in lockstep.
  //
  // The three cert fields below are ADDITIVE — appended for the auto-provisioned app registration
  // (Phase 3: writeProvisionedM365App), which also mints an Exchange Online app-only certificate
  // alongside the client secret. They're `optional: true` so a pre-existing password-only m365-admin
  // secret (the vast majority of the fleet) still passes checkFieldShape unchanged — the runner's
  // `exchange` secret is the one that actually requires a cert; here it's just where the auto-issued
  // cert lands so it lives next to the credential it belongs to.
  "m365-admin": [
    { label: "admin username / app id", anyOf: ["Username", "appID", "AppId", "ApplicationId", "ClientId"], hint: "Entra admin → App registrations → your app → Overview → Application (client) ID (a GUID, not a person's login)" },
    { label: "admin password / client secret", anyOf: ["Password", "Secret", "ClientSecret", "AppSecret"], hint: "the app registration → Certificates & secrets → New client secret → copy the Value (shown once)" },
    { label: "tenant id / domain", anyOf: ["TenantId", "Tenant", "Domain"], orClientDomain: true, hint: "same Overview page → Directory (tenant) ID; or leave blank to use the client's primary domain" },
    { label: "certificate (base64 pfx)", anyOf: ["CertificateBase64", "CertificatePfxBase64", "Certificate"], optional: true, hint: "app registration cert as base64 PFX (auto-provisioned; used for Exchange app-only)" },
    { label: "certificate password", anyOf: ["CertificatePassword", "CertPassword"], optional: true, hint: "password protecting the base64 PFX above (auto-generated at provisioning)" },
    { label: "certificate thumbprint", anyOf: ["CertificateThumbprint", "Certificate Thumbprint", "Thumbprint"], optional: true, hint: "SHA-1 thumbprint of the app cert" },
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
  // Zoom Server-to-Server OAuth app — synonyms MIRROR the runner's Use-CtgZoomSecret $pick (client id
  // also falls back to the secret's Username, client secret to its Password). All three are required.
  zoom: [
    { label: "account id", anyOf: ["AccountId", "AccountID", "Account ID", "Account"], hint: "Zoom App Marketplace → your Server-to-Server OAuth app → App Credentials → Account ID" },
    { label: "client id", anyOf: ["ClientId", "ClientID", "Client ID", "Username"], hint: "same app → Client ID" },
    { label: "client secret", anyOf: ["ClientSecret", "Client Secret", "Secret", "ApiKey", "Key", "Password"], hint: "same app → Client Secret" },
  ],
  // Egnyte — the runner mints a bearer token via the Resource Owner Password grant (developers.egnyte.com):
  // POST /puboauth/token with client_id (the API Key) + client_secret (the API Secret) + username + password.
  // So the credential is four fields: ClientID (key) + ClientSecret + AccountID (the admin login EMAIL, the
  // OAuth username — this is the stock "Automation - API" template's accountid slot) + Password. Synonyms
  // MIRROR the runner's Egnyte Connect $pick. Alternatively a pre-minted long-lived Token stands in for all
  // four — so each of the four is waived (unlessAnyPresent) when a Token is present, and a Token-only secret
  // (what the browser auto-setup harvests) still passes. Domain is the tenant subdomain (drakestar for
  // drakestar.egnyte.com), NOT the email domain — optional because the runner derives it from the login email.
  egnyte: [
    { label: "client id (key)", anyOf: ["ClientID", "ClientId", "Client ID", "Key", "APIKey", "API Key", "ApiKey"], unlessAnyPresent: EGNYTE_TOKEN_SYNONYMS, hint: "Egnyte calls this the API Key — developers.egnyte.com → your application → Key (the OAuth client_id)" },
    { label: "client secret", anyOf: ["ClientSecret", "Client Secret", "Secret", "API Secret", "APISecret"], unlessAnyPresent: EGNYTE_TOKEN_SYNONYMS, hint: "the API Secret paired with the key (required for keys issued after Jan 2015)" },
    { label: "account id (login email)", anyOf: ["accountid", "AccountId", "AccountID", "Account ID", "Account", "Username", "Email", "Login", "User"], unlessAnyPresent: EGNYTE_TOKEN_SYNONYMS, hint: "the Egnyte admin login email the token is minted on behalf of (the OAuth username)" },
    { label: "password", anyOf: ["Password", "Pass"], unlessAnyPresent: EGNYTE_TOKEN_SYNONYMS, hint: "that admin account's Egnyte password" },
    { label: "egnyte domain", anyOf: ["Domain", "EgnyteDomain", "Egnyte Domain", "Tenant"], optional: true, hint: "tenant subdomain — 'drakestar' for drakestar.egnyte.com; leave blank to derive it from the login email" },
    { label: "api token", anyOf: EGNYTE_TOKEN_SYNONYMS, optional: true, hint: "alternative to the four fields above: a pre-minted long-lived Egnyte access token" },
  ],
  // Egnyte admin CONSOLE login — the credential the browser auto-setup signs in WITH (email +
  // password, optional TOTP seed). DISTINCT from the `egnyte` API credential (domain + token) it
  // harvests. Used only by the egnyte-console-setup browser flow.
  "egnyte-console": [
    { label: "Egnyte admin email", anyOf: ["Username", "Email", "AdminEmail", "Admin Email", "User", "Login"], hint: "an Egnyte admin login that can read/generate the domain API token" },
    { label: "that account's password", anyOf: ["Password", "AdminPassword", "Pass"], hint: "that admin account's password (enable One-Time Password / a TOTP seed on the Delinea secret for MFA)" },
  ],
  // KnowBe4 SCIM — synonyms MIRROR the runner's KnowBe4 Connect $pick. The token is required; the base
  // URL is optional (defaults to the US endpoint, https://training.knowbe4.com/scim/v2).
  knowbe4: [
    { label: "SCIM token", anyOf: ["ScimToken", "SCIMToken", "SCIM Token", "Token", "ApiToken", "Key", "Password"], hint: "KnowBe4 console → Account Settings → User Management → SCIM → generate token" },
    { label: "base url (region)", anyOf: ["BaseUrl", "Base URL", "ScimUrl", "Url"], optional: true, hint: "override for non-US regions, e.g. https://eu.api.knowbe4.com/scim/v2 (EU) — leave blank for US" },
  ],
  // Mimecast API 2.0 application: client id + client secret.
  mimecast: [
    { label: "client id", anyOf: ["ClientID", "ClientId", "Client ID", "AppId", "Application ID", "Username"], hint: "Mimecast Administration Console → Services → API and Platform Integrations → your 2.0 app → Client ID" },
    { label: "client secret", anyOf: ["ClientSecret", "Client Secret", "Secret", "API Key", "ApiKey", "AccessToken", "Token", "Password"], hint: "same app → Client Secret (generated with the app; regenerate if lost)" },
  ],
  // Spanning Backup — synonym lists MIRROR the runner's Use-CtgSpanningSecret $pick exactly (so the
  // check can't disagree with what actually connects). The login falls back to the client domain; the
  // endpoint can be a full URL (apiURL/BaseUrl/Url) OR a Region. AccountID appears BOTH as a login
  // synonym (the runner's username fallback for legacy domain:token tenants) AND as the "account id"
  // requirement's canonical name — the create route maps an incoming key by exact LABEL match before
  // falling back to synonyms, so the guided setup's derived AccountID lands on the accountid slug
  // while a login posted as ClientID keeps the clientid slug.
  spanning: [
    { label: "login email", anyOf: ["ClientID", "ClientId", "Client ID", "Domain", "AccountID", "AccountId", "Account", "Tenant", "Username"], orClientDomain: true, hint: "the email you sign in to the Spanning admin console with (the API's Basic-auth username)" },
    { label: "api token", anyOf: ["ClientSecret", "AccessToken", "Access Token", "ApiToken", "API Key", "APIKey", "Api Key", "ApiKey", "Token", "Key", "Password"], hint: "the API Key — Spanning admin console → Settings → API Token, at the bottom of the page" },
    { label: "region or base url", anyOf: ["apiURL", "ApiUrl", "ApiURL", "BaseUrl", "Base URL", "Url", "URL", "Region"], hint: "https://<service>-api-<region>.spanningbackup.com — service o365 or google, region us/eu/ap/uk/ca" },
    // Optional: informational on the stock template (the runner authenticates with login email + token).
    // The guided setup derives it from the login email's domain; never flags as missing.
    { label: "account id", anyOf: ["AccountID", "AccountId", "Account ID", "accountid"], optional: true, hint: "the account domain without its suffix (acme.com → acme) — derived from the login email" },
  ],
  // Slack SCIM: a single Bearer token carrying the `admin` scope, generated by a Slack Owner/Admin.
  // Synonyms MIRROR the runner's Use-CtgSlackSecret pick list (the secret's own Password field is a
  // legitimate place for a token, so it's accepted last). SCIM also needs a Business+/Enterprise Grid
  // plan — that can't be checked from the field names, so the connection test names it instead.
  slack: [
    { label: "SCIM token (admin scope)", anyOf: ["Token", "ApiToken", "API Token", "AccessToken", "Access Token", "ApiKey", "API Key", "SCIMToken", "SCIM Token", "Password"] },
  ],
  // Slack admin console login the browser auto-setup signs in WITH — DISTINCT from the "slack" SCIM
  // token it attempts to harvest. An email+password Owner/Admin login; a TOTP seed (or One-Time
  // Password on the secret) clears MFA. NOTE: a workspace behind SSO or email magic-link can't use a
  // password login — those paste the SCIM token instead. Synonyms mirror Resolve-CtgSlackConsoleLogin.
  "slack-console": [
    { label: "Slack admin email", anyOf: ["Username", "Email", "AdminEmail", "User", "Login"], hint: "a Slack Owner/Admin login for the workspace (Business+/Enterprise Grid) that can manage apps + SCIM" },
    { label: "that account's password", anyOf: ["Password", "AdminPassword", "Pass"], hint: "that admin account's password (enable One-Time Password / a TOTP seed on the Delinea secret for MFA)" },
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
  // Mimecast ADMINISTRATION CONSOLE sign-in — the credential the browser console-setup flow signs in
  // WITH (login.mimecast.com), NOT the mimecast API 2.0 clientId/secret above. It is a SEPARATE secret
  // on purpose, for the same reasons spanning-portal is split from spanning: the console login is a
  // Mimecast admin email + password (Mimecast-native login), and feeding the API clientId/secret to a
  // login box cannot authenticate and walks a real admin account toward lockout. Licensing/API steps
  // never need this — a client without a console login stays fully ready; only the browser auto-setup
  // (create the API app in the console) uses it.
  //
  // MFA: enable One-Time Password on the Delinea secret — the runner mints the code AT the prompt, so
  // the seed never leaves the vault. It must be a TOTP/software token; push or phone-call MFA can't be
  // automated and the sign-in will simply time out at the prompt.
  //
  // Synonyms mirror the runner's Resolve-CtgMimecastConsoleLogin pick order (Username/email first, then
  // the generic pair — on a dedicated secret the generic Username/Password are the natural fields).
  "mimecast-console": [
    { label: "Mimecast admin email", anyOf: ["Username", "AdminEmail", "AdminUser", "Email", "User"], hint: "a Mimecast admin login with access to the Administration Console (Integrations → API and Platform Integrations)" },
    { label: "that account's password", anyOf: ["Password", "AdminPassword"], hint: "that admin account's password (enable One-Time Password on the Delinea secret for MFA)" },
  ],
  // Zoom admin console login the browser auto-setup signs in WITH to CREATE the Server-to-Server OAuth
  // app — DISTINCT from the "zoom" API credential (accountId/clientId/clientSecret) it produces. An
  // email+password admin login; a TOTP seed (or One-Time Password on the secret) clears MFA. NOTE: a
  // Zoom account behind org SSO won't accept a password login — those tenants paste the API cred instead.
  // Synonyms mirror the runner's Resolve-CtgZoomConsoleLogin pick order.
  "zoom-console": [
    { label: "Zoom admin email", anyOf: ["Username", "Email", "AdminEmail", "User", "Login"], hint: "a Zoom admin login that can create apps in the Zoom App Marketplace (Develop → Build App)" },
    { label: "that account's password", anyOf: ["Password", "AdminPassword", "Pass"], hint: "that admin account's password (enable One-Time Password / a TOTP seed on the Delinea secret for MFA)" },
  ],
  // Adobe Developer Console sign-in — the credential the browser console-setup flow signs in WITH
  // (developer.adobe.com/console) to create the User Management API OAuth Server-to-Server credential.
  // SEPARATE from the `adobe` API secret (client id/secret/org id) it PRODUCES: an Adobe admin login
  // (Adobe ID / federated email + password), with System/Developer role in the target Adobe org.
  "adobe-console": [
    { label: "Adobe admin email", anyOf: ["Username", "AdminEmail", "AdminUser", "Email", "User"], hint: "an Adobe admin (System or Developer role) that can create projects + credentials in the Adobe Developer Console for this org" },
    { label: "that account's password", anyOf: ["Password", "AdminPassword"], hint: "that admin account's password (enable One-Time Password on the Delinea secret for MFA)" },
  ],
  // KnowBe4 admin console interactive sign-in — the login the browser flow signs in WITH to enable and
  // harvest the SCIM token. NOT the SCIM token itself (that's the "knowbe4" secret above).
  "knowbe4-console": [
    { label: "KnowBe4 admin email", anyOf: ["Username", "AdminEmail", "AdminUser", "Email", "User"], hint: "a KnowBe4 admin login with access to Account Settings → User Management → SCIM" },
    { label: "that account's password", anyOf: ["Password", "AdminPassword"], hint: "that admin account's password (enable One-Time Password on the Delinea secret for MFA)" },
  ],
  // M365 Global Admin interactive sign-in — the credential the device-code browser flow logs in WITH.
  // This is an interactive M365 admin login (an email + that account's password), NOT the app
  // registration credentials above (app id + client secret). It is used for automated browser
  // authentication flows that require user context (e.g. device-code OAuth).
  //
  // MFA: enable One-Time Password on the Delinea secret — the runner mints the code AT the prompt, so
  // the seed never leaves the vault. It must be a TOTP/software token; push or phone-call MFA can't be
  // automated and the sign-in will simply time out at the prompt.
  //
  // Synonyms mirror the runner's pick order for interactive GA sign-in flows.
  "m365-global-admin": [
    { label: "M365 Global Admin email (UPN)", anyOf: ["Username", "AdminEmail", "AdminUser", "Email", "UPN", "User"] },
    { label: "that account's password", anyOf: ["Password", "AdminPassword"] },
  ],
  // Proofpoint Essentials API: admin email + password (sent as X-User / X-Password). The org domain
  // for the /orgs/{domain} path is satisfied by a Domain field OR the client's primary domain.
  proofpoint: [
    { label: "admin email (X-User)", anyOf: ["X-User", "Username", "AdminUser", "Admin", "Email", "User"], hint: "a Proofpoint Essentials admin login with API access enabled for this org" },
    { label: "admin password (X-Password)", anyOf: ["X-Password", "Password", "AdminPassword", "Secret", "ApiKey", "API Key", "Token"], hint: "that admin account's password" },
    { label: "org domain", anyOf: ["Domain", "OrgDomain", "Org", "Tenant"], orClientDomain: true, hint: "the org's primary domain (the /orgs/{domain} path); or leave blank to use the client's primary domain" },
    // Optional: the runner (Use-CtgProofpointSecret) already defaults to the "us1" pod when no
    // Region/BaseUrl-shaped field is present, so this must never flag as missing — it documents the
    // field the connector will USE if present (mirrors the value-probe's advisory-when-absent stance).
    { label: "region", anyOf: ["Region", "apiURL", "ApiUrl", "BaseUrl", "Base URL", "Url", "URL"], optional: true, hint: "the Proofpoint Essentials data region: us1..us5, eu1, or au1 (from your console URL)" },
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
  // Google Workspace service-account key (domain-wide delegation): a base64 JSON key + the SA's own
  // client email + the impersonated super-admin email DWD delegates to. Wired onto the stock
  // "Automation - API" template — the SAME template adobe/mimecast/spanning/proofpoint/slack use,
  // whose four stock fields are ClientID / ClientSecret / accountid / apiURL. Unlike those other
  // entries (whose `label` is human prose and the Secret Server slug is a separate concern), these
  // labels are deliberately spelled EXACTLY like the stock field names: writeGoogleWorkspaceCreds'
  // googleLabeledValues() keys its output by these same names, and delinea-templates.ts's
  // defaultFieldMap derives the write-path slug from `defaultSlug(anyOf[0])` — keeping both ends in
  // lockstep without needing a DELINEA_TEMPLATE_MAP override (accountid/apiURL do double duty here
  // the same way adobe repurposes accountid for its org id).
  "google-admin": [
    { label: "ClientSecret", anyOf: ["ClientSecret", "Client Secret", "Secret", "ApiKey", "Key"], hint: "Base64 of the service-account JSON key file" },
    { label: "accountid", anyOf: ["accountid", "AccountId", "Account ID", "Account"], hint: "the service account's client email (SA client email)" },
    { label: "apiURL", anyOf: ["apiURL", "ApiUrl", "ApiURL", "Url", "URL"], hint: "the impersonated super-admin email" },
    { label: "ClientID", anyOf: ["ClientID", "ClientId", "Client ID"], optional: true, hint: "the Workspace customer ID (defaults to my_customer)" },
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
      // Waived when an alternative-shape field is present (e.g. egnyte: a pre-minted Token replaces the
      // client_id/secret/account/password used to mint one), so neither shape false-flags the other.
      if (r.unlessAnyPresent && r.unlessAnyPresent.some((syn) => have.has(norm(syn)))) return false;
      return !r.anyOf.some((syn) => have.has(norm(syn)));
    })
    .map((r) => r.label);
  return { ok: missing.length === 0, missing };
}
