import { test } from "node:test";
import assert from "node:assert/strict";
import { previewM365 } from "./m365-preview";

const identity = { usernamePatterns: ["{firstInitial}{last}@{domain}"], password: { mode: "generate", minLength: 14, requireSpecial: true, requireUpper: true } };
const config = { licenses: ["Microsoft 365 E3", "Microsoft Entra ID P2"], groups: ["Mimecast TTP Users"] };

test("onboard: variables block + UPN pattern with domain + licenses + commands", () => {
  const out = previewM365("onboard", config, identity, "acme.com");
  assert.match(out, /variables/i);
  assert.match(out, /\$UserPrincipalName\s*=\s*"\{firstInitial\}\{last\}@acme\.com"/);
  assert.match(out, /\$Licenses\s*=\s*@\([\s\S]*Microsoft 365 E3/);
  assert.match(out, /\$Groups\s*=\s*@\([\s\S]*Mimecast TTP Users/);
  assert.match(out, /New-MgUser/);
  assert.match(out, /Set-MgUserLicense/);
  assert.match(out, /New-MgGroupMember/);
});

test("onboard: password rules from identity surface in the script", () => {
  const out = previewM365("onboard", config, identity, "acme.com");
  assert.match(out, /14/); // minLength
});

test("offboard: blocks sign-in / removes access", () => {
  const out = previewM365("offboard", { blockSignIn: true, removeLicense: true }, identity, "acme.com");
  assert.match(out, /AccountEnabled:?\s*\$false|Update-MgUser/);
});

test("missing config/identity still renders a valid-looking script", () => {
  const out = previewM365("onboard", {}, {}, "acme.com");
  assert.match(out, /New-MgUser/);
  assert.ok(out.length > 50);
});

test("null config/identity (system with no lane config) does not throw", () => {
  const out = previewM365("onboard", null, null, "acme.com");
  assert.match(out, /New-MgUser/);
  assert.match(out, /\$Licenses\s*=\s*@\(\)/); // empty
});
