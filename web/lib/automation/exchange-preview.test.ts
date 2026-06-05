import { test } from "node:test";
import assert from "node:assert/strict";
import { previewExchange } from "./exchange-preview";

test("onboard: no remote-mailbox config → skipped note", () => {
  assert.match(previewExchange("onboard", {}, null, "acme.com"), /skipped/i);
});

test("onboard: hybrid remote-mailbox → enable, sync-wait, regional", () => {
  const out = previewExchange(
    "onboard",
    { enableRemoteMailbox: { routingDomain: "coretell.mail.onmicrosoft.com", emailAddressPolicyEnabled: true }, regional: { language: "en-us", timezone: "Pacific Standard Time" }, waitForSync: true },
    null,
    "core.tech",
    { samAccountName: "aanand", userPrincipalName: "aanand@core.tech" }
  );
  assert.match(out, /Enable-RemoteMailbox/);
  assert.match(out, /\$Sam   = "aanand"/);
  assert.match(out, /\$Route = "\$Sam@coretell\.mail\.onmicrosoft\.com"/);
  assert.match(out, /Wait-CtgMailbox/);
  assert.match(out, /Set-MailboxRegionalConfiguration.*Pacific Standard Time/s);
});

test("offboard: converts to shared under threshold + blocks ActiveSync/OWA", () => {
  const out = previewExchange("offboard", { convertToShared: { skipIfMailboxOverGB: 50 }, blockMobileDevices: true }, null, "acme.com", { userPrincipalName: "jdoe@acme.com" });
  assert.match(out, /\$Upn\s*=\s*"jdoe@acme\.com"/);
  assert.match(out, /Get-CtgMailboxSizeGB/);
  assert.match(out, /Set-Mailbox -Identity \$Upn -Type Shared/);
  assert.match(out, /Set-CASMailbox/);
});

test("null config does not throw", () => {
  assert.ok(previewExchange("offboard", null, null, "acme.com").length > 10);
});
