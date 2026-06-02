import { test } from "node:test";
import assert from "node:assert/strict";
import { previewGoogleWorkspace } from "./google-workspace-preview";

test("onboard: creates the user if absent, places in the target OU, adds groups", () => {
  const out = previewGoogleWorkspace("onboard", { ou: "/Active Users", groups: ["staff"] }, null, "brightonpark.com", {
    workEmail: "jdoe@brightonpark.com", firstName: "Jane", lastName: "Doe",
  });
  assert.match(out, /\$PrimaryEmail = "jdoe@brightonpark\.com"/);
  assert.match(out, /if \(-not \(Get-CtgGoogleUser/);
  assert.match(out, /New-CtgGoogleUser/);
  assert.match(out, /never the Root OU/);
  assert.match(out, /Test-CtgGoogleMailFlow/); // required verification
});

test("offboard: captures evidence first, suspends, never deletes", () => {
  const out = previewGoogleWorkspace("offboard", { transferTarget: "mgr@brightonpark.com" }, null, "brightonpark.com", {
    userPrincipalName: "jdoe@brightonpark.com",
  });
  assert.match(out, /capture evidence FIRST/);
  assert.match(out, /Suspend-CtgGoogleUser/);
  assert.match(out, /NEVER deletes/);
  assert.match(out, /Transfer-CtgGoogleDrive -From \$PrimaryEmail -To "mgr@brightonpark\.com"/);
  assert.doesNotMatch(out, /Remove-.*-Method DELETE \/users/); // no user deletion
});

test("null config does not throw", () => {
  assert.ok(previewGoogleWorkspace("onboard", null, null, "brightonpark.com").length > 10);
});
