import { test } from "node:test";
import assert from "node:assert/strict";
import { previewAdobe } from "./adobe-preview";

test("onboard: adds the user to the configured product profiles", () => {
  const out = previewAdobe("onboard", { productProfiles: ["Creative Cloud All Apps"] }, null, "acme.com", { userPrincipalName: "jdoe@acme.com" });
  assert.match(out, /\$Email\s*=\s*"jdoe@acme\.com"/);
  assert.match(out, /Creative Cloud All Apps/);
  assert.match(out, /add = @\{ product = \$Profiles \}/);
});

test("offboard: removes the user from the org", () => {
  const out = previewAdobe("offboard", {}, null, "acme.com", { userPrincipalName: "jdoe@acme.com" });
  assert.match(out, /removeFromOrg/);
});

test("null config does not throw", () => {
  assert.ok(previewAdobe("onboard", null, null, "acme.com").length > 10);
});
