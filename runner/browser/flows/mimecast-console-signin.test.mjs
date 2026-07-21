// Pure-helper tests for the mimecast-console-signin flow. Imports ONLY the flow's pure export
// (looksSignedIn) — never the default flow, which needs a real browser. The full browser path
// (Mimecast sign-in through email -> password -> TOTP, and the post-login detection) is validated
// live via the guided-setup modal's "Test sign-in" button; it is kept out of these unit tests so the
// URL logic can be exercised without Chromium.
//
//   node --test flows/mimecast-console-signin.test.mjs        (from runner/browser)
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksSignedIn } from "./mimecast-console-signin.mjs";

test("looksSignedIn: the login host itself is NOT signed in", () => {
  assert.equal(looksSignedIn("https://login.mimecast.com/"), false);
  assert.equal(looksSignedIn("https://login.mimecast.com/m/login"), false);
});

test("looksSignedIn: a login/logon/sso path (even on another mimecast host) is NOT signed in", () => {
  assert.equal(looksSignedIn("https://eu-web.mimecast.com/login"), false);
  assert.equal(looksSignedIn("https://us-web.mimecast.com/sso/start"), false);
  assert.equal(looksSignedIn("https://us-web.mimecast.com/logon"), false);
});

test("looksSignedIn: a mimecast console host past the login screen IS signed in", () => {
  assert.equal(looksSignedIn("https://eu-web.mimecast.com/administration/"), true);
  assert.equal(looksSignedIn("https://us-web.mimecast.com/#dashboard"), true);
});

test("looksSignedIn: a non-mimecast host is never signed in (guards against a stray redirect)", () => {
  assert.equal(looksSignedIn("https://login.microsoftonline.com/common/oauth2/authorize"), false);
  assert.equal(looksSignedIn("https://evil.example.com/administration/"), false);
  // A look-alike suffix must not match ("notmimecast.com" endsWith "mimecast.com" is false anyway,
  // but a subdomain of another domain must also be rejected).
  assert.equal(looksSignedIn("https://mimecast.com.evil.example/"), false);
});

test("looksSignedIn: a non-URL yields false, never throws", () => {
  assert.equal(looksSignedIn("not a url"), false);
  assert.equal(looksSignedIn(""), false);
  assert.equal(looksSignedIn(undefined), false);
});
