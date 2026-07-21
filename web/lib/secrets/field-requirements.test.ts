import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFieldShape } from "./field-requirements";

test("m365-admin: needs username + password + tenant (or client domain)", () => {
  assert.deepEqual(checkFieldShape("m365-admin", ["Username", "Password", "TenantId"]), { ok: true, missing: [] });
  // missing tenant field, but the client's primary domain supplies it -> ok
  assert.deepEqual(checkFieldShape("m365-admin", ["Username", "Password"], { clientHasTenantHint: true }), { ok: true, missing: [] });
  // missing tenant with no domain hint -> flagged
  assert.deepEqual(checkFieldShape("m365-admin", ["Username", "Password"]), { ok: false, missing: ["tenant id / domain"] });
});

// A password-only m365-admin secret (the vast majority of the fleet — no cert fields at all) must
// still pass: the cert fields added for the auto-provisioned app registration (Phase 3) are optional.
test("m365-admin: a password-only secret (no cert fields) still passes — cert fields are optional", () => {
  assert.deepEqual(checkFieldShape("m365-admin", ["Username", "Password", "TenantId"]), { ok: true, missing: [] });
});

// The auto-provisioned app registration also carries an Exchange Online app-only certificate — its
// fields resolve by the same synonym mechanism as everything else, and staying absent never flags.
test("m365-admin: cert fields (base64 pfx / password / thumbprint) resolve when present, and are optional when absent", () => {
  assert.deepEqual(
    checkFieldShape("m365-admin", ["Username", "Password", "TenantId", "CertificateBase64", "CertificatePassword", "CertificateThumbprint"]),
    { ok: true, missing: [] }
  );
  // synonyms
  assert.deepEqual(
    checkFieldShape("m365-admin", ["Username", "Password", "TenantId", "CertificatePfxBase64", "CertPassword", "Thumbprint"]),
    { ok: true, missing: [] }
  );
  // absent entirely -> still ok (optional), never reported in `missing`
  assert.deepEqual(checkFieldShape("m365-admin", ["Username", "Password", "TenantId"]), { ok: true, missing: [] });
});

// Delinea's "Automation - Azure App" template stores the SAME app-registration credential as
// appID/Secret/tenantID that "Entra Azure AD Account" stores as Username/Password/TenantId. The
// runner accepts both (CRED_USERNAME_FIELDS/CRED_PASSWORD_FIELDS in Start-IamRunner.ps1) — these
// synonyms keep the app's Test in lockstep, so it can't go red on a credential that actually works.
test("m365-admin: the Automation - Azure App field spelling (appID/Secret/tenantID) is accepted", () => {
  assert.deepEqual(checkFieldShape("m365-admin", ["appID", "Secret", "tenantID"]), { ok: true, missing: [] });
  // the real CoreAutomation - Azure App field set, verbatim
  const coreAutomation = ["OrganizationLongName", "OrgShortName", "AzOrgSubscription", "AzOrgResourceGroup", "AzOrgLocation", "tenantID", "appID", "OnMicrosoftOrgName", "Secret"];
  assert.deepEqual(checkFieldShape("m365-admin", coreAutomation), { ok: true, missing: [] });
  // still catches a genuinely unusable secret
  assert.deepEqual(checkFieldShape("m365-admin", ["Notes"], { clientHasTenantHint: true }), {
    ok: false,
    missing: ["admin username / app id", "admin password / client secret"],
  });
});

test("exchange (online): needs an app id + a cert (thumbprint OR .pfx)", () => {
  assert.deepEqual(checkFieldShape("exchange", ["Username", "CertificateThumbprint"]), { ok: true, missing: [] });
  assert.deepEqual(checkFieldShape("exchange", ["Username", "CertificateBase64"]), { ok: true, missing: [] }); // cross-platform .pfx
  assert.deepEqual(checkFieldShape("exchange", ["Username"]), { ok: false, missing: ["certificate (thumbprint or .pfx)"] });
});

test("mimecast: synonyms satisfy client id + secret (case/space-insensitive)", () => {
  assert.deepEqual(checkFieldShape("mimecast", ["Client ID", "client secret"]), { ok: true, missing: [] });
  assert.deepEqual(checkFieldShape("mimecast", ["AppId"]), { ok: false, missing: ["client secret"] });
});

test("spanning: a full URL in apiURL satisfies 'region or base url' (mirrors the runner)", () => {
  // Secret 56433 stores the endpoint in apiURL, not Region/BaseUrl — must not false-flag.
  assert.deepEqual(checkFieldShape("spanning", ["ClientID", "ClientSecret", "apiURL"]), { ok: true, missing: [] });
  // Region instead of a URL also satisfies it.
  assert.deepEqual(checkFieldShape("spanning", ["AccountID", "Token", "Region"]), { ok: true, missing: [] });
  // No user field, but the client has a primary domain -> user requirement satisfied.
  assert.deepEqual(checkFieldShape("spanning", ["Token", "apiURL"], { clientHasTenantHint: true }), { ok: true, missing: [] });
  // Genuinely missing the endpoint -> flagged.
  assert.deepEqual(checkFieldShape("spanning", ["ClientID", "ClientSecret"]), { ok: false, missing: ["region or base url"] });
});

test("m365-global-admin: interactive GA login needs email + password", () => {
  assert.deepEqual(checkFieldShape("m365-global-admin", ["Username", "Password"]), { ok: true, missing: [] });
  // Synonyms (AdminEmail/AdminPassword) also work
  assert.deepEqual(checkFieldShape("m365-global-admin", ["AdminEmail", "AdminPassword"]), { ok: true, missing: [] });
  // Missing password -> flagged
  assert.deepEqual(checkFieldShape("m365-global-admin", ["Username"]), { ok: false, missing: ["that account's password"] });
  // Missing both -> flagged
  assert.deepEqual(checkFieldShape("m365-global-admin", ["Notes"]), { ok: false, missing: ["M365 Global Admin email (UPN)", "that account's password"] });
});

test("ad-dc: username + password required; the DC/server field is optional (on-DC agent)", () => {
  // Agent runs ON the DC: the "Active Directory Account" secret has only Username + Password and the
  // runner binds to the local domain (omits -Server) — must NOT flag a missing server.
  assert.deepEqual(checkFieldShape("ad-dc", ["Username", "Password"]), { ok: true, missing: [] });
  // An explicit Server, or the DC stored in the Documentation Link field (what the runner reads), is
  // also fine — and still clean.
  assert.deepEqual(checkFieldShape("ad-dc", ["Username", "Password", "Server"]), { ok: true, missing: [] });
  assert.deepEqual(checkFieldShape("ad-dc", ["Username", "Password", "Documentation Link"]), { ok: true, missing: [] });
  // Username/password are still genuinely required.
  assert.deepEqual(checkFieldShape("ad-dc", ["Username"]), { ok: false, missing: ["password"] });
});

test("proofpoint: admin email + password required; org domain from field or client", () => {
  assert.deepEqual(checkFieldShape("proofpoint", ["X-User", "X-Password", "Domain"]), { ok: true, missing: [] });
  // synonyms (Email/Password) + client primary domain supplies the org domain
  assert.deepEqual(checkFieldShape("proofpoint", ["Email", "Password"], { clientHasTenantHint: true }), { ok: true, missing: [] });
  // missing the password -> flagged
  assert.deepEqual(checkFieldShape("proofpoint", ["X-User"], { clientHasTenantHint: true }), { ok: false, missing: ["admin password (X-Password)"] });
});

test("unknown secret name has no rule -> never flagged", () => {
  assert.deepEqual(checkFieldShape("some-future-system", []), { ok: true, missing: [] });
});

test("google-admin: ClientSecret + accountid + apiURL required, ClientID optional", () => {
  assert.deepEqual(checkFieldShape("google-admin", ["ClientSecret", "accountid", "apiURL"]), { ok: true, missing: [] });
  // ClientID (customer id) absent entirely -> still ok (optional, defaults to my_customer)
  assert.deepEqual(checkFieldShape("google-admin", ["ClientSecret", "accountid", "apiURL"]), { ok: true, missing: [] });
  // present too -> still fine
  assert.deepEqual(checkFieldShape("google-admin", ["ClientID", "ClientSecret", "accountid", "apiURL"]), { ok: true, missing: [] });
  // missing the key -> flagged
  assert.deepEqual(checkFieldShape("google-admin", ["accountid", "apiURL"]), { ok: false, missing: ["ClientSecret"] });
  // missing everything -> all three required flagged, ClientID never appears
  assert.deepEqual(checkFieldShape("google-admin", ["Notes"]), { ok: false, missing: ["ClientSecret", "accountid", "apiURL"] });
});
