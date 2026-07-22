import { test } from "node:test";
import assert from "node:assert/strict";
import { findHarvested, scrubHarvested } from "./knowbe4-harvest";

test("findHarvested locates the SCIM token nested under Credentials", () => {
  const result = { System: "knowbe4-console-setup", Status: "ok", Credentials: { scimToken: "kb4-abc123def456ghi789", baseUrl: "https://eu.knowbe4.com/scim/v2" } };
  assert.deepEqual(findHarvested(result), { scimToken: "kb4-abc123def456ghi789", baseUrl: "https://eu.knowbe4.com/scim/v2" });
});

test("findHarvested tolerates PascalCase keys and a missing baseUrl", () => {
  assert.deepEqual(findHarvested({ x: { ScimToken: "  tok-xyz  " } }), { scimToken: "tok-xyz", baseUrl: undefined });
});

test("findHarvested returns null when no token is present", () => {
  assert.equal(findHarvested({ System: "knowbe4-console-setup", Status: "ok", Actions: ["signed in"] }), null);
  assert.equal(findHarvested({ Credentials: { scimToken: "   " } }), null); // blank token doesn't count
  assert.equal(findHarvested(null), null);
});

test("scrubHarvested removes the token everywhere and marks the result scrubbed", () => {
  const result = { System: "knowbe4-console-setup", Credentials: { scimToken: "secret-token", baseUrl: "https://training.knowbe4.com/scim/v2" }, Actions: ["ok"] };
  const scrubbed = scrubHarvested(result) as Record<string, unknown>;
  assert.equal(scrubbed._harvestScrubbed, true);
  assert.equal(findHarvested(scrubbed), null); // no token survives
  assert.equal(JSON.stringify(scrubbed).includes("secret-token"), false);
  // Non-secret context is preserved.
  assert.deepEqual(scrubbed.Actions, ["ok"]);
});
