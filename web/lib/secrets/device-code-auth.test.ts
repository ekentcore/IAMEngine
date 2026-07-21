import { test } from "node:test";
import assert from "node:assert/strict";
import { startDeviceCode, pollDeviceCodeToken } from "./device-code-auth";

const OK = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const ERR = (b: unknown, status = 400) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

test("startDeviceCode returns the user code + verification uri", async () => {
  const f = (async () => OK({ device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin", interval: 5, expires_in: 900 })) as unknown as typeof fetch;
  const r = await startDeviceCode("tenant.com", f);
  assert.equal(r.ok && r.userCode, "ABCD-EFGH");
  assert.equal(r.ok && r.deviceCode, "dc");
});

test("pollDeviceCodeToken loops through authorization_pending then succeeds", async () => {
  let n = 0;
  const f = (async () => (++n < 3 ? ERR({ error: "authorization_pending" }) : OK({ access_token: "the-token" }))) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok && r.token, "the-token");
  assert.equal(n, 3);
});

test("pollDeviceCodeToken surfaces authorization_declined distinctly (no retry)", async () => {
  let n = 0;
  const f = (async () => { n++; return ERR({ error: "authorization_declined" }); }) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "authorization_declined");
  assert.equal(n, 1); // terminal, not retried
});

test("pollDeviceCodeToken gives up on expired_token / deadline", async () => {
  const f = (async () => ERR({ error: "expired_token" })) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "expired_token");
});

test("pollDeviceCodeToken returns expired_token once the injected clock crosses the deadline", async () => {
  let calls = 0;
  const f = (async () => { calls++; return ERR({ error: "authorization_pending" }); }) as unknown as typeof fetch;
  // now() is called once to compute the deadline, then once per while-check.
  // Stay under the deadline for the first two reads (deadline calc + first loop check),
  // then jump well past it so the loop exits on the next check.
  let n = 0;
  const now = () => (n++ < 2 ? 0 : 2_000_000);
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 1, sleep: async () => {}, now }, f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "expired_token");
  assert.ok(calls >= 1);
});

test("pollDeviceCodeToken retries a transient HTTP failure then succeeds", async () => {
  let n = 0;
  const f = (async () => {
    n++;
    if (n === 1) return ERR({}, 503); // transient, no recognizable OAuth error body
    return OK({ access_token: "the-token" });
  }) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok && r.token, "the-token");
  assert.equal(n, 2);
});

test("pollDeviceCodeToken treats a terminal 4xx with an unparseable/non-OAuth body as TERMINAL, not retryable", async () => {
  let n = 0;
  // An HTML gateway/error page (or Azure's nested {"error":{"code":...}} shape, where top-level
  // `error` is an object so `code` reads undefined) on a non-retryable HTTP status must NOT be
  // looped on for the full device-code lifetime.
  const f = (async () => {
    n++;
    return new Response("<html><body>Bad Request</body></html>", { status: 400, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok, false);
  assert.equal(n, 1); // terminal — called exactly once, not looped
  assert.notEqual(!r.ok && r.code, "expired_token");
  assert.equal(!r.ok && r.code, "http_400");
});

test("pollDeviceCodeToken stops after repeated network exceptions and reports network_error (not expired_token)", async () => {
  let n = 0;
  const f = (async () => {
    n++;
    throw new Error("fetch failed: ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {} }, f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "network_error");
  assert.notEqual(!r.ok && r.code, "expired_token");
  assert.ok(n >= 4 && n < 10, `expected to stop after a small consecutive-failure threshold, got ${n} calls`);
  assert.ok(!r.ok && /ECONNREFUSED/.test(r.error));
});

test("pollDeviceCodeToken exits with code 'cancelled' when the signal aborts (no further token calls)", async () => {
  const controller = new AbortController();
  let n = 0;
  const f = (async () => { n++; return ERR({ error: "authorization_pending" }); }) as unknown as typeof fetch;
  const sleep = async () => { controller.abort(); }; // the cancel lands while the poll sleeps
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep, signal: controller.signal }, f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "cancelled");
  assert.equal(n, 0, "no token call after the abort");
});

test("pollDeviceCodeToken with a pre-aborted signal returns immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
  const r = await pollDeviceCodeToken("tenant.com", "dc", { intervalSeconds: 5, expiresInSeconds: 900, sleep: async () => {}, signal: controller.signal }, f);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "cancelled");
});
