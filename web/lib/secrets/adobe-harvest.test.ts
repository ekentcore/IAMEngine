import { test } from "node:test";
import assert from "node:assert/strict";
import { findAdobeHarvested, scrubAdobeHarvested } from "./adobe-harvest";

test("findAdobeHarvested deep-finds the credential wherever the runner nests it", () => {
  // Nested under the psm1's `Credentials` note-property, mixed casing.
  const result = { System: "adobe-console-setup", Status: "ok", Credentials: { clientId: "abc123", ClientSecret: "sh-secret", orgId: "DEAD00@AdobeOrg" } };
  assert.deepEqual(findAdobeHarvested(result), { clientId: "abc123", clientSecret: "sh-secret", orgId: "DEAD00@AdobeOrg" });
});

test("findAdobeHarvested tolerates a missing orgId (optional)", () => {
  assert.deepEqual(findAdobeHarvested({ Credentials: { clientId: "a", clientSecret: "b" } }), { clientId: "a", clientSecret: "b" });
});

test("findAdobeHarvested returns null when no credential is present", () => {
  assert.equal(findAdobeHarvested({ System: "adobe-console-setup", Status: "ok", Actions: ["signed in"] }), null);
  assert.equal(findAdobeHarvested(null), null);
  assert.equal(findAdobeHarvested({ clientId: "only-id" }), null); // no secret -> not a match
});

test("scrubAdobeHarvested drops the secret + Credentials and marks scrubbed", () => {
  const scrubbed = scrubAdobeHarvested({ Status: "ok", Credentials: { clientId: "a", clientSecret: "sh-secret", orgId: "X@AdobeOrg" }, note: "keep" }) as Record<string, unknown>;
  assert.equal(scrubbed._harvestScrubbed, true);
  assert.equal(scrubbed.note, "keep");
  assert.equal(JSON.stringify(scrubbed).includes("sh-secret"), false); // secret gone
  assert.equal(JSON.stringify(scrubbed).includes("Credentials"), false); // note-property gone
  // A second scrub is idempotent + still finds no harvested credential.
  assert.equal(findAdobeHarvested(scrubbed), null);
});
