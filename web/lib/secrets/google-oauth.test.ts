import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GCLOUD_CLIENT_ID,
  GCLOUD_CLIENT_SECRET,
  CLOUD_PLATFORM_SCOPE,
  OAUTH_REDIRECT_URI,
  makePkcePair,
  buildAuthUrl,
  exchangeCodeForToken,
} from "./google-oauth";

const OK = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const ERR = (b: unknown, status = 400) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

test("makePkcePair returns a base64url verifier with no +/= characters", () => {
  const { verifier } = makePkcePair();
  assert.equal(verifier.length, 43); // 32 random bytes, base64url, no padding
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test("makePkcePair challenge is the RFC 7636 S256 transform of the verifier", () => {
  const { verifier, challenge } = makePkcePair();
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test("makePkcePair produces a fresh pair each call", () => {
  const a = makePkcePair();
  const b = makePkcePair();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
});

test("buildAuthUrl embeds client_id, redirect_uri, scope, S256 challenge method, and login_hint", () => {
  const url = buildAuthUrl("the-challenge", "user@example.com");
  assert.match(url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("client_id"), GCLOUD_CLIENT_ID);
  assert.equal(parsed.searchParams.get("redirect_uri"), OAUTH_REDIRECT_URI);
  assert.equal(parsed.searchParams.get("scope"), CLOUD_PLATFORM_SCOPE);
  assert.equal(parsed.searchParams.get("code_challenge"), "the-challenge");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("login_hint"), "user@example.com");
  // offline is load-bearing: online redemptions are refused (rapt_required) under Workspace
  // Google Cloud session-control reauth policies — see buildAuthUrl's comment.
  assert.equal(parsed.searchParams.get("access_type"), "offline");
  assert.equal(parsed.searchParams.get("prompt"), "consent");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  // redirect_uri must actually be URL-encoded in the raw string (not left as a bare loopback URL)
  assert.ok(url.includes(encodeURIComponent(OAUTH_REDIRECT_URI)));
});

test("exchangeCodeForToken posts the authorization_code grant with the verifier and returns the access token", async () => {
  let capturedBody = "";
  let capturedUrl = "";
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return OK({ access_token: "the-access-token", token_type: "Bearer", expires_in: 3599 });
  }) as unknown as typeof fetch;

  const r = await exchangeCodeForToken("auth-code-123", "verifier-abc", f);

  assert.equal(capturedUrl, "https://oauth2.googleapis.com/token");
  const params = new URLSearchParams(capturedBody);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("code"), "auth-code-123");
  assert.equal(params.get("code_verifier"), "verifier-abc");
  assert.equal(params.get("client_id"), GCLOUD_CLIENT_ID);
  assert.equal(params.get("client_secret"), GCLOUD_CLIENT_SECRET);
  assert.equal(params.get("redirect_uri"), OAUTH_REDIRECT_URI);

  assert.equal(r.ok, true);
  assert.equal(r.ok && r.accessToken, "the-access-token");
});

test("exchangeCodeForToken returns {ok:false} (never throws) on a non-200 response", async () => {
  const f = (async () => ERR({ error: "invalid_grant", error_description: "Bad Request" }, 400)) as unknown as typeof fetch;
  const r = await exchangeCodeForToken("bad-code", "verifier-abc", f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "invalid_grant");
});

test("exchangeCodeForToken returns {ok:false} when the response is 200 but has no access_token", async () => {
  const f = (async () => OK({ token_type: "Bearer" })) as unknown as typeof fetch;
  const r = await exchangeCodeForToken("code", "verifier", f);
  assert.equal(r.ok, false);
});

test("exchangeCodeForToken never echoes the raw response body or a token into the error string", async () => {
  const secretLookingBody = { error: "invalid_grant", access_token: "should-never-appear-in-error", extra: "junk-body-field" };
  const f = (async () => ERR(secretLookingBody, 400)) as unknown as typeof fetch;
  const r = await exchangeCodeForToken("code", "verifier", f);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.error.includes("should-never-appear-in-error"));
  assert.ok(!r.ok && !r.error.includes("junk-body-field"));
});

test("exchangeCodeForToken does not throw on a network exception", async () => {
  const f = (async () => { throw new Error("fetch failed: ECONNREFUSED"); }) as unknown as typeof fetch;
  const r = await exchangeCodeForToken("code", "verifier", f);
  assert.equal(r.ok, false);
});
