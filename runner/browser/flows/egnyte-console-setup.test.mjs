import { test } from "node:test";
import assert from "node:assert/strict";
import { egnyteConsoleUrl, looksSignedIn, harvestComplete } from "./egnyte-console-setup.mjs";

test("egnyteConsoleUrl builds an https egnyte.com URL from a bare subdomain, host, or full URL", () => {
  assert.equal(egnyteConsoleUrl("drakestar"), "https://drakestar.egnyte.com/");
  assert.equal(egnyteConsoleUrl("drakestar.egnyte.com"), "https://drakestar.egnyte.com/");
  assert.equal(egnyteConsoleUrl("https://drakestar.egnyte.com/app"), "https://drakestar.egnyte.com/app");
  assert.equal(egnyteConsoleUrl(""), "");
  assert.equal(egnyteConsoleUrl(undefined), "");
});

test("looksSignedIn: true on an egnyte.com app page, false on a login route or foreign host", () => {
  assert.equal(looksSignedIn("https://drakestar.egnyte.com/app/index.do"), true);
  assert.equal(looksSignedIn("https://drakestar.egnyte.com/login"), false);
  assert.equal(looksSignedIn("https://drakestar.egnyte.com/sso/saml"), false);
  assert.equal(looksSignedIn("https://evil.com/app"), false);
  assert.equal(looksSignedIn("not-a-url"), false);
});

test("harvestComplete: needs a plausibly-long token string", () => {
  assert.equal(harvestComplete({ domain: "drakestar", token: "abcdef1234567890" }), true);
  assert.equal(harvestComplete({ domain: "drakestar", token: "short" }), false); // too short
  assert.equal(harvestComplete({ domain: "drakestar", token: "" }), false);
  assert.equal(harvestComplete(null), false);
});
