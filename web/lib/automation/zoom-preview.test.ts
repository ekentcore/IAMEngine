import { test } from "node:test";
import assert from "node:assert/strict";
import { previewZoom } from "./zoom-preview";

test("onboard: creates the user if absent, with the resolved email", () => {
  const out = previewZoom("onboard", { type: 2 }, null, "acme.com", { userPrincipalName: "jdoe@acme.com", firstName: "Jane", lastName: "Doe" });
  assert.match(out, /\$Email\s*=\s*"jdoe@acme\.com"/);
  assert.match(out, /Get-CtgZoomUser/);
  assert.match(out, /Invoke-CtgZoomApi -Method POST -Path '\/users'/);
});

test("offboard: deactivates by default, deletes when configured", () => {
  assert.match(previewZoom("offboard", {}, null, "acme.com", { userPrincipalName: "jdoe@acme.com" }), /deactivate/);
  assert.match(previewZoom("offboard", { delete: true }, null, "acme.com", { userPrincipalName: "jdoe@acme.com" }), /DELETE/);
});

test("null config does not throw", () => {
  assert.ok(previewZoom("onboard", null, null, "acme.com").length > 10);
});
