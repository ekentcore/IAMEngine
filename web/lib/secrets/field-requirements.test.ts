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

test("unknown secret name has no rule -> never flagged", () => {
  assert.deepEqual(checkFieldShape("some-future-system", []), { ok: true, missing: [] });
});
