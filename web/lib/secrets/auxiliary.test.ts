import { test } from "node:test";
import assert from "node:assert/strict";
import { wiredOptionalSecrets } from "./auxiliary";
import { isOptionalSecret } from "./optional-secrets";
import { NOT_NEEDED } from "@/lib/cases/case-secrets";

// The whole point: an optional secret is attached ONLY when it's actually wired. An unwired name would
// be treated as REQUIRED downstream (the claim gate skips a job with an unreferenced secret, and the
// runner brokers every listed name), which would make the step unclaimable for the entire fleet.
test("an optional secret is attached only when the client has really wired it", () => {
  assert.deepEqual(wiredOptionalSecrets("spanning", [{ name: "spanning-portal", externalId: "12345" }]), ["spanning-portal"]);
  assert.deepEqual(wiredOptionalSecrets("spanning", []), []);
});

test("a placeholder / not-needed / blank reference does NOT count as wired", () => {
  for (const externalId of ["", "   ", "REPLACE_ME", NOT_NEEDED, null]) {
    assert.deepEqual(wiredOptionalSecrets("spanning", [{ name: "spanning-portal", externalId }]), [], `externalId ${JSON.stringify(externalId)} must not count as wired`);
  }
});

test("systems with no optional secrets get nothing", () => {
  assert.deepEqual(wiredOptionalSecrets("m365", [{ name: "spanning-portal", externalId: "1" }]), []);
});

test("isOptionalSecret knows the portal login is optional and the API credential is not", () => {
  assert.equal(isOptionalSecret("spanning-portal"), true);
  assert.equal(isOptionalSecret("spanning"), false);
});
