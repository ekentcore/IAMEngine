// The vulnerability this pins shut: every runner-API route used to derive the acting agent's
// identity from `body.agentId` — a value the CALLER controls. Any machine holding a valid bearer
// token (even one minted for a different client's agent) could impersonate an arbitrary agentId
// in the body and act as it. These two tests prove the fix at the composition seam: identity comes
// from the authenticated token (authenticateAgent), never from the request body, and a service
// method still enforces assignment even if a route were to (incorrectly) pass the wrong id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { generateAgentToken } from "@/lib/runner/agent-token";
import { makeRunnerService } from "./runner-service";
import { HttpError } from "./types";

const req = (bearer: string) => ({ headers: { get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${bearer}` : null) } });

test("agent A's token cannot authenticate as central/agent B (cross-client claim is impossible)", async () => {
  const tA = generateAgentToken();
  const db = {
    agent: {
      findFirst: async ({ where }: any) =>
        where.tokenPrefix === tA.prefix ? { id: "agentA", clientId: "clientA", enabled: true, tokenHash: tA.hash } : null,
    },
  } as any;
  // Caller presents A's token but claims to be the central runner (clientId null → all clients).
  const authed = await authenticateAgent(db, req(tA.token), "central-agent");
  assert.equal(authed.id, "agentA");
  assert.equal(authed.clientId, "clientA"); // NOT null — cannot escalate to all-clients
});

test("brokerCredential refuses a job the authenticated agent is not assigned to", async () => {
  const db = {
    job: { findUnique: async () => ({ status: "running", assignedAgentId: "agentB", request: { secretNames: ["m365"] }, case: { clientId: "clientB", secretOverrides: null, client: { parentId: null } } }) },
    agent: { findUnique: async () => ({ id: "agentA", enabled: true }) },
  } as any;
  const svc = makeRunnerService(db);
  // authenticated as agentA (from its token), but the job belongs to agentB → 403
  await assert.rejects(() => svc.brokerCredential("job1", "agentA", "m365"), (e: any) => e instanceof HttpError && e.status === 403);
});
