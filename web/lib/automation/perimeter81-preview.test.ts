import { test } from "node:test";
import assert from "node:assert/strict";
import { previewPerimeter81 } from "./perimeter81-preview";

test("onboard: group-driven — does not add the user directly", () => {
  const out = previewPerimeter81("onboard", { ensureLicenseAvailable: true }, null, "acme.com", { userPrincipalName: "jdoe@acme.com" });
  assert.match(out, /group-driven/i);
  assert.match(out, /NOT added directly/);
  assert.match(out, /\/api\/v1\/licenses/);
});

test("offboard: finds then removes the user", () => {
  const out = previewPerimeter81("offboard", { removeUser: true }, null, "acme.com", { userPrincipalName: "jdoe@acme.com" });
  assert.match(out, /Find-CtgP81User/);
  assert.match(out, /DELETE/);
});

test("null config does not throw", () => {
  assert.ok(previewPerimeter81("onboard", null, null, "acme.com").length > 10);
});
