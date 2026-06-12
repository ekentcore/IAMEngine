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

test("exchange (online): needs an app id + a certificate thumbprint", () => {
  assert.deepEqual(checkFieldShape("exchange", ["Username", "CertificateThumbprint"]), { ok: true, missing: [] });
  assert.deepEqual(checkFieldShape("exchange", ["Username"]), { ok: false, missing: ["certificate thumbprint"] });
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

test("unknown secret name has no rule -> never flagged", () => {
  assert.deepEqual(checkFieldShape("some-future-system", []), { ok: true, missing: [] });
});
