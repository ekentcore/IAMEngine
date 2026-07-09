import { test } from "node:test";
import assert from "node:assert/strict";
import { previewMimecast } from "./mimecast-preview";

test("onboard: triggers sync, checks the user profile, verifies the internal domain", () => {
  const out = previewMimecast("onboard", { syncAll: true, verifyInternalDirectory: "@acme.com" }, null, "acme.com");
  assert.match(out, /execute-sync/);
  assert.match(out, /get-profile/);
  assert.match(out, /get-internal-domain/);
  assert.match(out, /acme\.com/);
});

test("onboard: createIfMissing previews the cloud-user create", () => {
  const out = previewMimecast("onboard", { createIfMissing: true }, null, "acme.com");
  assert.match(out, /create-user/);
});

test("offboard: removes from configured groups using the resolved email", () => {
  const out = previewMimecast("offboard", { groups: ["grp-1"] }, null, "acme.com", { userPrincipalName: "jdoe@acme.com" });
  assert.match(out, /\$Email\s*=\s*"jdoe@acme\.com"/);
  assert.match(out, /remove-group-member/);
});

test("null config does not throw", () => {
  assert.ok(previewMimecast("onboard", null, null, "acme.com").length > 10);
});
