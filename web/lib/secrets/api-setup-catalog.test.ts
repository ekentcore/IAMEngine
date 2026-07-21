import { test } from "node:test";
import assert from "node:assert/strict";
import { API_SETUP_CATALOG, apiSetupFor } from "./api-setup-catalog";
import { SECRET_FIELD_REQUIREMENTS } from "./field-requirements";

test("catalog has mimecast, spanning, proofpoint, each with a real field-requirements secret", () => {
  const keys = API_SETUP_CATALOG.map((e) => e.systemKey).sort();
  assert.deepEqual(keys, ["mimecast", "proofpoint", "spanning"]);
  for (const e of API_SETUP_CATALOG) {
    assert.ok(SECRET_FIELD_REQUIREMENTS[e.secretName], `${e.secretName} must be a known secret`);
    assert.ok(e.label && e.consoleUrl.startsWith("https://") && e.steps.length > 0);
  }
});
test("proofpoint entry offers region options", () => {
  assert.ok((apiSetupFor("proofpoint")?.regionOptions ?? []).includes("us1"));
});
test("spanning entry derives its URL/account id from service + region pickers", () => {
  const e = apiSetupFor("spanning");
  assert.equal(e?.derive, "spanning");
  assert.deepEqual(e?.serviceOptions, ["o365", "google"]);
  assert.ok((e?.regionOptions ?? []).includes("us"));
  assert.equal(e?.regionOptions?.[0], "us"); // the default select value — the typical region
});
test("apiSetupFor returns undefined for an unknown system", () => {
  assert.equal(apiSetupFor("google"), undefined);
});
