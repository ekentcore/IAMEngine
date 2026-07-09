import { test } from "node:test";
import assert from "node:assert/strict";
import { previewActiveDirectory } from "./active-directory-preview";

test("onboard: creates the user in the OU, maps home drive, adds groups", () => {
  const cfg = { ou: "Staff", homeDrive: { unc: "\\\\srv\\home\\<username>", letter: "H" }, groups: ["All Staff"] };
  const out = previewActiveDirectory("onboard", cfg, null, "acme.com", { samAccountName: "jdoe", displayName: "Jane Doe", userPrincipalName: "jdoe@acme.com", firstName: "Jane", lastName: "Doe" });
  assert.match(out, /\$Sam\s*=\s*"jdoe"/);
  assert.match(out, /OU=Staff,DC=acme,DC=com/);
  assert.match(out, /New-ADUser/);
  assert.match(out, /Set-ADUser -Identity \$Sam -HomeDrive "H:"/);
  assert.match(out, /Add-ADGroupMember/);
});

test("offboard: honors the do-not-move-ou guardrail", () => {
  const cfg = { removeAllGroups: true, hideFromGal: { attribute: "msExchHideFromAddressLists", value: "TRUE" }, disableAccount: true, disabledUsersOu: "OU=Disabled,DC=acme,DC=com", guardrails: ["do-not-move-ou"] };
  const out = previewActiveDirectory("offboard", cfg, null, "acme.com", { samAccountName: "jdoe" });
  assert.match(out, /Disable-ADAccount/);
  assert.match(out, /do-not-move-ou guardrail/);
  assert.doesNotMatch(out, /Move-ADObject/);
});

test("offboard: moves to the Disabled OU when no guardrail", () => {
  const out = previewActiveDirectory("offboard", { disableAccount: true, disabledUsersOu: "OU=Disabled,DC=acme,DC=com" }, null, "acme.com", { samAccountName: "jdoe" });
  assert.match(out, /Move-ADObject/);
});

test("null config does not throw", () => {
  const out = previewActiveDirectory("onboard", null, null, "acme.com");
  assert.match(out, /New-ADUser/);
});

test("onboard: renders the attribute map and the mirror-user step when present", () => {
  const out = previewActiveDirectory(
    "onboard",
    { ou: "Finance", groups: ["DEPT-Finance"], attributes: { title: "Analyst", department: "Finance" }, mirrorFromUser: "Christine Holleran" },
    null,
    "core.tech",
    { samAccountName: "aanand", displayName: "Avni Anand", userPrincipalName: "aanand@core.tech", firstName: "Avni", lastName: "Anand" }
  );
  assert.match(out, /\$Attributes = @\{/);
  assert.match(out, /department = "Finance"/);
  assert.match(out, /mirror — union the LIVE group memberships of "Christine Holleran"/);
  assert.match(out, /Get-ADUser -Filter "DisplayName -eq 'Christine Holleran'" -Properties MemberOf/);
});
