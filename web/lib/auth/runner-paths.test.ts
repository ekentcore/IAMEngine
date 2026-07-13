import { test } from "node:test";
import assert from "node:assert/strict";
import { isRunnerApi, isRunnerBootstrap, isSecretBearing } from "./runner-paths";

// The regression these tests exist for: /api/runner/* used to be blanket-exempt from BOTH the bearer
// gate and the session gate ("runner bundle download — open"). Two credential-carrying routes were
// later added under that prefix and silently inherited the exemption, leaving the Delinea credential
// broker reachable with no auth at all.
test("credential-carrying runner routes are bearer-gated, not open", () => {
  // Returns resolved Delinea secret VALUES for every pending client.
  assert.equal(isRunnerApi("/api/runner/cloud-groups/claim"), true);
  assert.equal(isRunnerApi("/api/runner/cloud-groups/result"), true);
  // Conn-test broker: returns a resolved secret's fields.
  assert.equal(isRunnerApi("/api/runner/conn-tests/claim"), true);
  assert.equal(isRunnerApi("/api/runner/conn-tests/abc123/credential"), true);
  assert.equal(isRunnerApi("/api/runner/conn-tests/abc123/result"), true);

  for (const p of ["/api/runner/cloud-groups/claim", "/api/runner/conn-tests/abc123/credential"]) {
    assert.equal(isRunnerBootstrap(p), false, `${p} must not be in the open bootstrap surface`);
  }
});

test("a NEW route under /api/runner/ is gated by default", () => {
  // The whole point of the allowlist: someone adding a credential-carrying route tomorrow gets the
  // bearer gate for free rather than inheriting the open prefix.
  assert.equal(isRunnerApi("/api/runner/some-future-secret-route"), true);
  assert.equal(isRunnerBootstrap("/api/runner/some-future-secret-route"), false);
});

test("bootstrap paths stay open — a host with no token must install and self-update", () => {
  for (const p of ["/api/runner/manifest", "/api/runner/file", "/api/runner/install.ps1", "/api/runner/troubleshoot.ps1"]) {
    assert.equal(isRunnerBootstrap(p), true, `${p} must stay open`);
    assert.equal(isRunnerApi(p), false, `${p} must not require a bearer`);
  }
});

test("the existing machine endpoints stay bearer-gated", () => {
  assert.equal(isRunnerApi("/api/jobs/claim"), true);
  assert.equal(isRunnerApi("/api/jobs/xyz/credential"), true);
  assert.equal(isRunnerApi("/api/jobs/xyz/result"), true);
  assert.equal(isRunnerApi("/api/jobs/xyz/progress"), true);
  assert.equal(isRunnerApi("/api/agents/abc/heartbeat"), true);
});

test("enrollment (POST /api/agents, exact) is NOT bearer-gated — it has its own enroll token", () => {
  assert.equal(isRunnerApi("/api/agents"), false);
});

// The dev-mode fail-open is the reason the live box served these unauthenticated: RUNNER_API_TOKEN
// was empty and NODE_ENV was "development", so the bearer gate waved every runner call through.
// Routes that return resolved Delinea secret VALUES must fail closed in EVERY environment.
test("secret-bearing routes are identified so they can fail closed even in dev", () => {
  assert.equal(isSecretBearing("/api/jobs/abc123/credential"), true);
  assert.equal(isSecretBearing("/api/runner/conn-tests/abc123/credential"), true);
  assert.equal(isSecretBearing("/api/runner/cloud-groups/claim"), true);
});

test("routes that do NOT return secret values keep the dev fail-open", () => {
  // These carry no credential in the response, so a tokenless local runner still works.
  for (const p of ["/api/jobs/claim", "/api/jobs/abc/result", "/api/jobs/abc/progress", "/api/agents/abc/heartbeat", "/api/runner/cloud-groups/result", "/api/runner/conn-tests/claim"]) {
    assert.equal(isSecretBearing(p), false, `${p} does not return secret values`);
  }
});

test("every secret-bearing route is also a bearer-gated runner API", () => {
  for (const p of ["/api/jobs/abc/credential", "/api/runner/conn-tests/abc/credential", "/api/runner/cloud-groups/claim"]) {
    assert.equal(isRunnerApi(p), true, `${p} must be bearer-gated`);
    assert.equal(isRunnerBootstrap(p), false, `${p} must never be open`);
  }
});

test("the operator surface is not mistaken for a runner API", () => {
  for (const p of ["/api/cases/abc/dispatch", "/api/clients/acme/secrets", "/api/health", "/clients"]) {
    assert.equal(isRunnerApi(p), false, `${p} is operator surface`);
    assert.equal(isRunnerBootstrap(p), false);
  }
});
