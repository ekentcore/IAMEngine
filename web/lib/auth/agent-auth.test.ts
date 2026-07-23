import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { authenticateAgent } from "./agent-auth";
import { generateAgentToken } from "@/lib/runner/agent-token";
import { HttpError } from "@/lib/jobs/types";

// Minimal fake of the one Prisma call authenticateAgent makes.
function fakeDb(agents: any[]) {
  return {
    agent: {
      findFirst: async ({ where }: any) => {
        return (
          agents.find((a) => {
            if (where.deletedAt === null && a.deletedAt) return false;
            if (where.tokenPrefix !== undefined) return a.tokenPrefix === where.tokenPrefix;
            if (where.id !== undefined) return a.id === where.id;
            return false;
          }) ?? null
        );
      },
    },
  } as any;
}

const req = (bearer?: string) => ({ headers: { get: (n: string) => (n.toLowerCase() === "authorization" && bearer ? `Bearer ${bearer}` : null) } });

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

test("a valid per-agent token authenticates as ITS agent, ignoring the claimed body agentId", async () => {
  const t = generateAgentToken();
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true, tokenHash: t.hash, tokenPrefix: t.prefix }]);
  const authed = await authenticateAgent(db, req(t.token), "agentB"); // caller lies: claims to be agentB
  assert.deepEqual(authed, { id: "agentA", clientId: "clientA", via: "per-agent" });
});

test("a wrong per-agent token is rejected 401", async () => {
  const real = generateAgentToken();
  const forged = generateAgentToken();
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true, tokenHash: real.hash, tokenPrefix: real.prefix }]);
  // forged has a different prefix → no row → 401
  await assert.rejects(() => authenticateAgent(db, req(forged.token)), (e: any) => e instanceof HttpError && e.status === 401);
});

test("a disabled agent is rejected 403 even with a valid token", async () => {
  const t = generateAgentToken();
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: false, tokenHash: t.hash, tokenPrefix: t.prefix }]);
  await assert.rejects(() => authenticateAgent(db, req(t.token)), (e: any) => e instanceof HttpError && e.status === 403);
});

test("the shared token is accepted in dual-mode and identity comes from the claimed agentId", async () => {
  process.env.RUNNER_API_TOKEN = "shared-xyz";
  delete process.env.RUNNER_REQUIRE_PER_AGENT;
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true, tokenConfirmedAt: null }]);
  const authed = await authenticateAgent(db, req("shared-xyz"), "agentA");
  assert.deepEqual(authed, { id: "agentA", clientId: "clientA", via: "shared" });
});

test("a CONFIRMED agent may not fall back to the shared token", async () => {
  process.env.RUNNER_API_TOKEN = "shared-xyz";
  delete process.env.RUNNER_REQUIRE_PER_AGENT;
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true, tokenConfirmedAt: new Date() }]);
  await assert.rejects(() => authenticateAgent(db, req("shared-xyz"), "agentA"), (e: any) => e instanceof HttpError && e.status === 401);
});

test("once RUNNER_REQUIRE_PER_AGENT=true the shared token is rejected outright", async () => {
  process.env.RUNNER_API_TOKEN = "shared-xyz";
  process.env.RUNNER_REQUIRE_PER_AGENT = "true";
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true }]);
  await assert.rejects(() => authenticateAgent(db, req("shared-xyz"), "agentA"), (e: any) => e instanceof HttpError && e.status === 401);
});

test("a missing bearer is rejected 401", async () => {
  const db = fakeDb([]);
  await assert.rejects(() => authenticateAgent(db, req(undefined)), (e: any) => e instanceof HttpError && e.status === 401);
});
