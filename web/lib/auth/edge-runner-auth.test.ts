import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeRunnerAuthDecision } from "./edge-runner-auth";

const base = {
  sharedToken: "shared-xyz",
  requirePerAgent: false,
  perAgentEdgeEnabled: true,
  secretBearing: false,
  prod: true,
};

test("a per-agent token passes the edge (validated in-handler)", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, bearer: "agt_abc" }), { action: "pass" });
});

test("the correct shared token passes in dual-mode", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, bearer: "shared-xyz" }), { action: "pass" });
});

test("a wrong shared token is rejected 401", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, bearer: "nope" }), { action: "reject", status: 401 });
});

test("no bearer is rejected 401", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, bearer: null }), { action: "reject", status: 401 });
});

test("after cutover the shared token is rejected but per-agent still passes", () => {
  const cut = { ...base, requirePerAgent: true };
  assert.deepEqual(edgeRunnerAuthDecision({ ...cut, bearer: "shared-xyz" }), { action: "reject", status: 401 });
  assert.deepEqual(edgeRunnerAuthDecision({ ...cut, bearer: "agt_abc" }), { action: "pass" });
});

test("no shared token configured: a per-agent token still passes (post-cutover steady state)", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, sharedToken: undefined, bearer: "agt_abc" }), { action: "pass" });
});

test("no shared token configured + non-agent bearer on a secret-bearing route fails closed 503", () => {
  assert.deepEqual(
    edgeRunnerAuthDecision({ ...base, sharedToken: undefined, secretBearing: true, bearer: "whatever" }),
    { action: "reject", status: 503 },
  );
});

test("an agt_ token is REJECTED at the edge while perAgentEdgeEnabled is false (pre-wiring)", () => {
  const gated = { ...base, perAgentEdgeEnabled: false };
  // shared token configured → falls through to the shared-token check → 401
  assert.deepEqual(edgeRunnerAuthDecision({ ...gated, bearer: "agt_abc" }), { action: "reject", status: 401 });
  // no shared token + secret-bearing route → fail closed 503 (agt_ must not slip through)
  assert.deepEqual(
    edgeRunnerAuthDecision({ ...gated, sharedToken: undefined, secretBearing: true, bearer: "agt_abc" }),
    { action: "reject", status: 503 },
  );
});

test("an agt_ token passes at cutover even if perAgentEdgeEnabled is false", () => {
  assert.deepEqual(
    edgeRunnerAuthDecision({ ...base, perAgentEdgeEnabled: false, requirePerAgent: true, bearer: "agt_abc" }),
    { action: "pass" },
  );
});
