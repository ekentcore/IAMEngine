import { test } from "node:test";
import assert from "node:assert/strict";
import { API_SETUP_CATALOG, apiSetupFor, isBrowserLoginSecret } from "./api-setup-catalog";
import { SECRET_FIELD_REQUIREMENTS } from "./field-requirements";

test("catalog covers the guided-setup vendors, each with a real field-requirements secret", () => {
  const keys = API_SETUP_CATALOG.map((e) => e.systemKey).sort();
  assert.deepEqual(keys, ["adobe", "egnyte", "knowbe4", "mimecast", "proofpoint", "slack", "spanning", "zoom"]);
  for (const e of API_SETUP_CATALOG) {
    assert.ok(SECRET_FIELD_REQUIREMENTS[e.secretName], `${e.secretName} must be a known secret`);
    assert.ok(e.label && e.consoleUrl.startsWith("https://") && e.steps.length > 0);
    // helpPath is optional — only the vendors with an in-app /help guide set it; when present it must point there.
    if (e.helpPath !== undefined) assert.ok(e.helpPath.startsWith("/help/"), `${e.systemKey} helpPath must be a /help/ link`);
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
test("isBrowserLoginSecret marks console-login secrets, not API creds", () => {
  assert.equal(isBrowserLoginSecret("spanning-portal"), true); // a vendor console login
  assert.equal(isBrowserLoginSecret("spanning"), false); // the API credential itself
  assert.equal(isBrowserLoginSecret("m365-global-admin"), true); // the device-code GA login
  assert.equal(isBrowserLoginSecret("mimecast-console"), true);
  assert.equal(isBrowserLoginSecret("mimecast"), false);
});
