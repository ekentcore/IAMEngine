import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isAgentToken, verifyToken } from "@/lib/runner/agent-token";

const savedEdgeEnabled = process.env.RUNNER_PER_AGENT_EDGE_ENABLED;
const savedRequirePerAgent = process.env.RUNNER_REQUIRE_PER_AGENT;

afterEach(() => {
  if (savedEdgeEnabled === undefined) delete process.env.RUNNER_PER_AGENT_EDGE_ENABLED;
  else process.env.RUNNER_PER_AGENT_EDGE_ENABLED = savedEdgeEnabled;
  if (savedRequirePerAgent === undefined) delete process.env.RUNNER_REQUIRE_PER_AGENT;
  else process.env.RUNNER_REQUIRE_PER_AGENT = savedRequirePerAgent;
});

// enroll() must persist a hash and hand back a matching plaintext token exactly once — but only
// once the edge is actually configured to admit agt_ bearers (RUNNER_PER_AGENT_EDGE_ENABLED, or the
// RUNNER_REQUIRE_PER_AGENT cutover). Minting before then would hand out a token the edge rejects.
test("enroll mints a per-agent token whose plaintext matches the stored hash (edge flag on)", async () => {
  process.env.RUNNER_PER_AGENT_EDGE_ENABLED = "true";
  delete process.env.RUNNER_REQUIRE_PER_AGENT;
  let stored: any = null;
  const db = {
    client: { findUnique: async () => ({ id: "clientA" }) },
    agent: { create: async ({ data, select }: any) => { stored = data; return { id: "agentX", scope: data.scope, clientId: data.clientId }; } },
    auditLog: { create: async () => ({}) },
  } as any;
  const { makeRunnerService } = await import("./runner-service");
  const out = await makeRunnerService(db).enroll({ name: "dc1", scope: "client_network", clientSlug: "client-a" });
  assert.ok(out.agentToken && isAgentToken(out.agentToken), "returns an agt_ token");
  assert.ok(stored.tokenHash && stored.tokenPrefix, "persists hash + prefix");
  assert.equal(verifyToken(out.agentToken!, stored.tokenHash), true, "plaintext matches stored hash");
  assert.ok(stored.tokenConfirmedAt, "new agent starts confirmed on per-agent auth");
});

// With the edge flag off (and no cutover), enroll() must NOT mint or persist a token — the freshly
// enrolled agent falls back to the shared token like every other pre-migration agent.
test("enroll mints NO per-agent token when the edge flag is unset", async () => {
  delete process.env.RUNNER_PER_AGENT_EDGE_ENABLED;
  delete process.env.RUNNER_REQUIRE_PER_AGENT;
  let stored: any = null;
  const db = {
    client: { findUnique: async () => ({ id: "clientA" }) },
    agent: { create: async ({ data, select }: any) => { stored = data; return { id: "agentX", scope: data.scope, clientId: data.clientId }; } },
    auditLog: { create: async () => ({}) },
  } as any;
  const { makeRunnerService } = await import("./runner-service");
  const out = await makeRunnerService(db).enroll({ name: "dc1", scope: "client_network", clientSlug: "client-a" });
  assert.equal(out.agentToken, undefined, "returns no agentToken");
  assert.equal(stored.tokenHash, undefined, "persists no tokenHash");
  assert.equal(stored.tokenPrefix, undefined, "persists no tokenPrefix");
});
