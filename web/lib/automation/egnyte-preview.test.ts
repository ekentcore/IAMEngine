import { test } from "node:test";
import assert from "node:assert/strict";
import { previewEgnyte } from "./egnyte-preview";

test("onboard: creates a power user by default", () => {
  const out = previewEgnyte("onboard", {}, null, "drakestar.com", { userPrincipalName: "jdoe@drakestar.com" });
  assert.match(out, /jdoe@drakestar\.com/);
  assert.match(out, /userType = 'power'/);
  assert.match(out, /\/pubapi\/v2\/users/);
});

test("onboard: honors a configured userType", () => {
  const out = previewEgnyte("onboard", { userType: "standard" }, null, "drakestar.com");
  assert.match(out, /userType = 'standard'/);
});

test("offboard: deactivates by default, deletes only with config", () => {
  const deact = previewEgnyte("offboard", {}, null, "drakestar.com", { userPrincipalName: "jdoe@drakestar.com" });
  assert.match(deact, /active = \$false/);
  assert.doesNotMatch(deact, /DELETE/);
  const del = previewEgnyte("offboard", { delete: true }, null, "drakestar.com");
  assert.match(del, /DELETE/);
});

test("null config does not throw", () => {
  assert.ok(previewEgnyte("onboard", null, null, "drakestar.com").length > 10);
});
