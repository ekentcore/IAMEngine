import { test } from "node:test";
import assert from "node:assert/strict";
import { looksSignedIn, harvestComplete } from "./zoom-console-setup.mjs";

test("looksSignedIn: a zoom.us page past the sign-in screen is signed-in; a /signin page is not", () => {
  assert.equal(looksSignedIn("https://marketplace.zoom.us/develop/create"), true);
  assert.equal(looksSignedIn("https://us02web.zoom.us/account"), true);
  assert.equal(looksSignedIn("https://zoom.us/signin"), false);
  assert.equal(looksSignedIn("https://zoom.us/login"), false);
  assert.equal(looksSignedIn("https://evil.com/marketplace.zoom.us"), false); // host, not path
  assert.equal(looksSignedIn("not a url"), false);
});

test("harvestComplete: true only when all three values are present and non-empty", () => {
  assert.equal(harvestComplete({ accountId: "a", clientId: "b", clientSecret: "c" }), true);
  assert.equal(harvestComplete({ accountId: "a", clientId: "b", clientSecret: "" }), false);
  assert.equal(harvestComplete({ accountId: "", clientId: "b", clientSecret: "c" }), false);
  assert.equal(harvestComplete(null), false);
  assert.equal(harvestComplete(undefined), false);
});
