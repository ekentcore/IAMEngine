import { test } from "node:test";
import assert from "node:assert/strict";
import { previewM365 } from "@/lib/automation/m365-preview";
import type { Identity } from "@/lib/clients/types";

const identity: Identity = {
  backbone: "ad-synced",
  usernamePatterns: ["{first}{last}@{domain}"],
  password: { minLength: 14, requireChangeAtSignIn: true },
};

test("onboard renders the variables block from config + identity", () => {
  const out = previewM365(
    "onboard",
    { licenses: ["Microsoft 365 E3", "Defender"], groups: ["Mimecast TTP Users"] },
    identity,
    "61commodities.com"
  );
  assert.match(out, /# --- variables \(populated from the UM case later\) ---/);
  assert.match(out, /\$Licenses\s*= @\("Microsoft 365 E3", "Defender"\)/);
  assert.match(out, /\$Groups\s*= @\("Mimecast TTP Users"\)/);
  assert.match(out, /\$UserPrincipalName = "\{first\}\{last\}@61commodities\.com"/);
  assert.match(out, /New-MgUser/);
  assert.match(out, /Set-MgUserLicense/);
  assert.ok(!out.includes("$Alias"), "no alias variable when none configured");
});

test("onboard adds the alias only when config.alias is set", () => {
  const out = previewM365("onboard", { alias: "info@x.com" }, identity, "x.com");
  assert.match(out, /\$Alias\s*= "info@x\.com"/);
  assert.match(out, /Update-MgUser .*ProxyAddresses/);
});

test("offboard renders the offboard branch", () => {
  const out = previewM365("offboard", { blockSignIn: true, removeAllGroups: true }, identity, "x.com");
  assert.match(out, /AccountEnabled:\$false/);
  assert.match(out, /Remove-MgGroupMemberByRef/);
  assert.doesNotMatch(out, /New-MgUser/);
});
