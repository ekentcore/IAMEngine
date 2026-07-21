// Pure-helper tests for the google-oauth-signin flow. These import ONLY the flow's pure exports
// (redirect parsing + result-line formatting) — never the default flow, which needs a real browser.
// The full browser path (Google sign-in through email -> password -> TOTP -> consent, and the
// redirect capture) is validated live in Task 12; it is deliberately kept out of these unit tests so
// the parse/format logic can be exercised without Chromium (which isn't installed in CI here).
//
//   node --test flows/google-oauth-signin.test.mjs        (from runner/browser)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOAuthRedirect, matchesRedirect, formatOAuthCodeLine, isBenignSigninText } from "./google-oauth-signin.mjs";

const REDIRECT = "http://127.0.0.1:8765/oauth2callback";

test("parseOAuthRedirect: extracts the authorization code from the callback query", () => {
  const r = parseOAuthRedirect(`${REDIRECT}?code=4/0Abc_De-fGh&scope=https://www.googleapis.com/auth/admin`);
  assert.equal(r.code, "4/0Abc_De-fGh");
  assert.equal(r.error, null);
});

test("parseOAuthRedirect: decodes a percent-encoded code (Google url-encodes the slash)", () => {
  const r = parseOAuthRedirect(`${REDIRECT}?code=4%2F0Abc%2FdEf&state=xyz`);
  assert.equal(r.code, "4/0Abc/dEf");
  assert.equal(r.error, null);
});

test("parseOAuthRedirect: surfaces an OAuth error param and yields no code", () => {
  const r = parseOAuthRedirect(`${REDIRECT}?error=access_denied&error_description=The+user+said+no`);
  assert.equal(r.code, null);
  assert.equal(r.error, "access_denied");
  assert.match(r.errorDescription, /said no/);
});

test("parseOAuthRedirect: a callback with neither code nor error yields nulls (not a throw)", () => {
  const r = parseOAuthRedirect(REDIRECT);
  assert.equal(r.code, null);
  assert.equal(r.error, null);
});

test("parseOAuthRedirect: a malformed URL yields nulls rather than throwing", () => {
  const r = parseOAuthRedirect("not a url");
  assert.equal(r.code, null);
  assert.equal(r.error, null);
});

test("matchesRedirect: true for the callback regardless of its query string", () => {
  assert.equal(matchesRedirect(`${REDIRECT}?code=x`, REDIRECT), true);
  assert.equal(matchesRedirect(REDIRECT, REDIRECT), true);
  assert.equal(matchesRedirect(`${REDIRECT}?error=access_denied`, REDIRECT), true);
});

test("matchesRedirect + parseOAuthRedirect: the exact live refused-navigation URL shape (iss + code + scope)", () => {
  // The URL Chromium reported on requestfailed in the first live Drive Capital run — the server-302
  // hop that page.route never saw. The listener path must both match it and parse the code out.
  const live = `${REDIRECT}?iss=${encodeURIComponent("https://accounts.google.com")}&code=4/0AeanS0bLIVE&scope=${encodeURIComponent("https://www.googleapis.com/auth/cloud-platform")}`;
  assert.equal(matchesRedirect(live, REDIRECT), true);
  assert.deepEqual(parseOAuthRedirect(live), { code: "4/0AeanS0bLIVE", error: null, errorDescription: null });
});

test("matchesRedirect: false for Google's own auth pages and other paths on the same host", () => {
  assert.equal(matchesRedirect("https://accounts.google.com/o/oauth2/v2/auth?client_id=x", REDIRECT), false);
  assert.equal(matchesRedirect("http://127.0.0.1:8765/somethingelse?code=x", REDIRECT), false);
});

test("matchesRedirect: false for a bogus current-url", () => {
  assert.equal(matchesRedirect("about:blank", REDIRECT), false);
  assert.equal(matchesRedirect("", REDIRECT), false);
});

test("formatOAuthCodeLine: prints the exact contract line the app's OAUTH_CODE regex reads", () => {
  const line = formatOAuthCodeLine("4/0Abc_De-fGh");
  assert.equal(line, "OAUTH_CODE:4/0Abc_De-fGh");
  // The app-side matcher: /(^|\n)\s*OAUTH_CODE:(\S+)/ — prove the produced line matches and captures.
  const m = line.match(/(^|\n)\s*OAUTH_CODE:(\S+)/);
  assert.ok(m, "the produced line must match the app's OAUTH_CODE regex");
  assert.equal(m[2], "4/0Abc_De-fGh");
});

test("isBenignSigninText: the 'Welcome' heading (the real-UA password page) is NOT a rejection", () => {
  // The live-run regression: the newer Google layout renders <h1>Welcome</h1> on the password page;
  // it must never be read as "Google rejected the sign-in".
  assert.equal(isBenignSigninText("Welcome"), true);
  assert.equal(isBenignSigninText("Welcome\ncoretech@drivecapital.com"), true);
  assert.equal(isBenignSigninText("  welcome  "), true);
  assert.equal(isBenignSigninText("Sign in"), true);
  assert.equal(isBenignSigninText("Choose an account"), true);
  assert.equal(isBenignSigninText(""), true);
  assert.equal(isBenignSigninText(null), true);
});

test("isBenignSigninText: genuine sign-in errors are NOT treated as benign", () => {
  assert.equal(isBenignSigninText("Wrong password. Try again or click Forgot password to reset it."), false);
  assert.equal(isBenignSigninText("Couldn't find your Google Account"), false);
  assert.equal(isBenignSigninText("Wrong code. Try again."), false);
  assert.equal(isBenignSigninText("This account is disabled"), false);
});
