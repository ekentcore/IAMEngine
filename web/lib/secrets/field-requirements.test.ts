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
