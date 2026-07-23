import { test } from "node:test";
import assert from "node:assert/strict";
import { planTokenRefresh, planTokenConfirm } from "./agent-token-refresh";
import { isAgentToken } from "@/lib/runner/agent-token";

test("planTokenRefresh mints a new token when a refresh is armed", () => {
  const plan = planTokenRefresh({ tokenRefreshRequested: true });
  assert.ok(plan, "a plan is produced");
  assert.ok(isAgentToken(plan!.token), "minted token is agt_-prefixed");
  assert.equal(plan!.update.tokenPrefix, plan!.token.slice(0, 12));
  assert.equal(plan!.update.tokenRefreshRequested, false, "flag is consumed");
  assert.ok(plan!.update.tokenProvisionedAt instanceof Date);
  assert.ok(plan!.update.tokenRefreshDeliveredAt instanceof Date);
});

test("planTokenRefresh does nothing when no refresh is armed", () => {
  assert.equal(planTokenRefresh({ tokenRefreshRequested: false }), null);
});

test("planTokenConfirm stamps confirmedAt on first per-agent auth", () => {
  const plan = planTokenConfirm({ via: "per-agent", tokenConfirmedAt: null });
  assert.ok(plan?.tokenConfirmedAt instanceof Date);
  assert.equal("tokenRotatedAt" in (plan ?? {}), false, "not a rotation on first confirm");
});

test("planTokenConfirm stamps rotatedAt when an already-confirmed agent re-auths on a new token", () => {
  const plan = planTokenConfirm({ via: "per-agent", tokenConfirmedAt: new Date("2026-01-01") });
  assert.ok(plan?.tokenRotatedAt instanceof Date);
});

test("planTokenConfirm does nothing for a shared-token heartbeat", () => {
  assert.equal(planTokenConfirm({ via: "shared", tokenConfirmedAt: null }), null);
});
