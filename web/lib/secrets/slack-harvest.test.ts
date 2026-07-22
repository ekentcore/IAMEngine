import { test } from "node:test";
import assert from "node:assert/strict";
import { findHarvested, scrubHarvested } from "./slack-harvest";

test("findHarvested digs the SCIM token out of a nested runner result", () => {
  const result = { ok: true, data: [{ System: "slack-console-setup", Credentials: { token: " xoxp-scim " } }] };
  assert.deepEqual(findHarvested(result), { token: "xoxp-scim" });
  // Alternate spellings.
  assert.deepEqual(findHarvested({ Credentials: { SCIMToken: "tok" } }), { token: "tok" });
  // No token -> null (never a partial/empty credential).
  assert.equal(findHarvested({ Credentials: { token: "" } }), null);
  assert.equal(findHarvested({ nope: true }), null);
  assert.equal(findHarvested(null), null);
});

test("scrubHarvested removes the token + Credentials and marks the result scrubbed", () => {
  const result = { ok: true, data: [{ Credentials: { token: "xoxp-scim" } }], note: "keep" };
  const scrubbed = scrubHarvested(result) as Record<string, unknown>;
  assert.equal(scrubbed._harvestScrubbed, true);
  assert.ok(!JSON.stringify(scrubbed).includes("xoxp-scim"));
  assert.ok(!JSON.stringify(scrubbed).includes("Credentials"));
  assert.equal(findHarvested(scrubbed), null);
});
