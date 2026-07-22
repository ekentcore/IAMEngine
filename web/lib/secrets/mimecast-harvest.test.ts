import { test } from "node:test";
import assert from "node:assert/strict";
import { findHarvested, scrubHarvested } from "./mimecast-harvest";

test("findHarvested locates the credential object however the runner nests it", () => {
  assert.deepEqual(findHarvested({ Credentials: { clientId: "abc", clientSecret: "shh" } }), { clientId: "abc", clientSecret: "shh" });
  // deeply nested + envelope wrapping
  assert.deepEqual(findHarvested({ data: [{ result: { Credentials: { clientId: " a ", clientSecret: " b " } } }] }), { clientId: "a", clientSecret: "b" });
  // casing variants
  assert.deepEqual(findHarvested({ ClientID: "x", ClientSecret: "y" }), { clientId: "x", clientSecret: "y" });
});

test("findHarvested returns null when no credential is present", () => {
  assert.equal(findHarvested({ Status: "ok", Actions: ["signed in"] }), null);
  assert.equal(findHarvested({ clientId: "abc" }), null); // secret missing
  assert.equal(findHarvested(null), null);
  assert.equal(findHarvested("string"), null);
});

test("scrubHarvested removes the secret keys and marks the result scrubbed", () => {
  const out = scrubHarvested({ Status: "ok", Credentials: { clientId: "abc", clientSecret: "shh" } }) as Record<string, unknown>;
  assert.equal(out._harvestScrubbed, true);
  assert.equal(out.Credentials, undefined);
  assert.equal(out.Status, "ok");
  // a bare clientSecret leaf is also stripped
  const out2 = scrubHarvested({ a: { clientSecret: "shh", clientId: "abc" } }) as Record<string, Record<string, unknown>>;
  assert.equal(out2.a.clientSecret, undefined);
  assert.equal(out2.a.clientId, "abc"); // the id is not a secret — kept
});
