import { test } from "node:test";
import assert from "node:assert/strict";
import { findHarvested, scrubHarvested } from "./zoom-harvest";

test("findHarvested digs the credential out of a nested runner result (all three required)", () => {
  const result = { ok: true, data: [{ System: "zoom-console-setup", Credentials: { accountId: " acc ", clientId: "cid", clientSecret: "shh" } }] };
  assert.deepEqual(findHarvested(result), { accountId: "acc", clientId: "cid", clientSecret: "shh" });
  // Missing any one field -> null (never a partial credential).
  assert.equal(findHarvested({ Credentials: { accountId: "a", clientId: "b" } }), null);
  assert.equal(findHarvested({ nope: true }), null);
  assert.equal(findHarvested(null), null);
});

test("scrubHarvested removes the secret + Credentials and marks the result scrubbed", () => {
  const result = { ok: true, data: [{ Credentials: { accountId: "a", clientId: "b", clientSecret: "shh" } }], note: "keep" };
  const scrubbed = scrubHarvested(result) as Record<string, unknown>;
  assert.equal(scrubbed._harvestScrubbed, true);
  // No clientSecret / Credentials survive anywhere.
  assert.ok(!JSON.stringify(scrubbed).includes("shh"));
  assert.ok(!JSON.stringify(scrubbed).includes("Credentials"));
  assert.equal(findHarvested(scrubbed), null);
});
