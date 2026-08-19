import { test } from "node:test";
import assert from "node:assert/strict";
import { adUpnFor } from "../profiles/ad-domain";
import { ALWAYS_ON_PREM_SYSTEMS } from "../cases/case-secrets";

// The override applied at dispatch, extracted so it is testable without a database.
// (If the implementation inlines it, export a named helper and import that instead.)
import { applyAdStandaloneUpn } from "./ad-standalone-upn";

const client = {
  backbone: "ad_standalone",
  identity: { usernamePatterns: ["{firstinitial}{last}@{domain}"], adDomain: "syee.local" },
};
const payload = { firstName: "Suzanne", lastName: "Yee", userPrincipalName: "syee@olympuscosmetic.com" };

test("every on-prem AD system gets the AD-domain UPN", () => {
  for (const systemKey of ALWAYS_ON_PREM_SYSTEMS) {
    const out = applyAdStandaloneUpn(payload, systemKey, client);
    assert.equal(out.userPrincipalName, "syee@syee.local", `${systemKey} got the AD UPN`);
  }
});

test("cloud lanes keep the mail-domain UPN", () => {
  for (const systemKey of ["m365", "entra", "exchange", "mimecast"]) {
    const out = applyAdStandaloneUpn(payload, systemKey, client);
    assert.equal(out.userPrincipalName, "syee@olympuscosmetic.com", `${systemKey} kept the mail UPN`);
  }
});

test("an ad_synced client is untouched on every lane", () => {
  const synced = { backbone: "ad_synced", identity: client.identity };
  for (const systemKey of [...ALWAYS_ON_PREM_SYSTEMS, "m365", "entra"]) {
    const out = applyAdStandaloneUpn(payload, systemKey, synced);
    assert.equal(out.userPrincipalName, "syee@olympuscosmetic.com", `${systemKey} unchanged`);
  }
});

test("a standalone client with no adDomain is untouched", () => {
  const out = applyAdStandaloneUpn(payload, "active-directory",
    { backbone: "ad_standalone", identity: { usernamePatterns: ["{first}.{last}@{domain}"] } });
  assert.equal(out.userPrincipalName, "syee@olympuscosmetic.com");
});

test("the original payload is not mutated", () => {
  const before = JSON.stringify(payload);
  applyAdStandaloneUpn(payload, "active-directory", client);
  assert.equal(JSON.stringify(payload), before);
});
