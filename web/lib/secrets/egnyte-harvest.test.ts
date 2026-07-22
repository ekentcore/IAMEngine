import { test } from "node:test";
import assert from "node:assert/strict";
import { findHarvested, scrubHarvested } from "./egnyte-harvest";

test("findHarvested locates a plausibly-long token nested under Credentials", () => {
  const result = { System: "egnyte-console-setup", Status: "ok", Credentials: { domain: "drakestar", token: "egnyteApiToken1234567" } };
  assert.deepEqual(findHarvested(result), { domain: "drakestar", token: "egnyteApiToken1234567" });
});

test("findHarvested tolerates field-name casing and a missing (echoed) domain", () => {
  assert.deepEqual(findHarvested({ x: { Token: "abcdefghij0123456" } }), { domain: "", token: "abcdefghij0123456" });
});

test("findHarvested returns null when there's no token / it's too short", () => {
  assert.equal(findHarvested({ Credentials: { domain: "d", token: "short" } }), null);
  assert.equal(findHarvested({ nope: true }), null);
  assert.equal(findHarvested(null), null);
});

test("scrubHarvested strips the token/Credentials and marks the result scrubbed", () => {
  const scrubbed = scrubHarvested({ Status: "ok", Credentials: { domain: "d", token: "egnyteApiToken1234567" }, keep: "me" }) as Record<string, unknown>;
  assert.equal(scrubbed._harvestScrubbed, true);
  assert.equal(scrubbed.keep, "me");
  assert.equal(JSON.stringify(scrubbed).includes("egnyteApiToken1234567"), false);
  assert.equal("Credentials" in scrubbed, false);
});
