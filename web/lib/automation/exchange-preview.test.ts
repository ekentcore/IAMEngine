import { test } from "node:test";
import assert from "node:assert/strict";
import { previewExchange } from "./exchange-preview";

test("onboard: notes there is no onboard lane", () => {
  assert.match(previewExchange("onboard", {}, null, "acme.com"), /no onboard lane/i);
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
