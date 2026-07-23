// The runner trust boundary. authenticateAgent() turns a bearer token into an AUTHENTICATED agent
// identity. The per-agent token IS the identity: the returned clientId comes from the token's own
// Agent row, so a caller can never scope claims/broker to another client by lying in the body.
//
// Two token schemes exist during the migration window:
//   - per-agent (agt_...): authoritative. Resolved by prefix, verified by hash.
//   - shared (legacy RUNNER_API_TOKEN): identity still comes from the claimed body agentId, allowed
//     ONLY until cutover (RUNNER_REQUIRE_PER_AGENT) and NEVER for an already-migrated (confirmed) agent.
import { timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { HttpError } from "@/lib/jobs/types";
import { isAgentToken, tokenPrefix, verifyToken } from "@/lib/runner/agent-token";

export type AuthedAgent = { id: string; clientId: string | null; via: "per-agent" | "shared" };

type AgentDb = Pick<PrismaClient, "agent">;
type ReqLike = { headers: { get(name: string): string | null } };

function bearer(req: ReqLike): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function authenticateAgent(db: AgentDb, req: ReqLike, claimedAgentId?: string | null): Promise<AuthedAgent> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "missing bearer token");

  // --- Per-agent token: the token is the identity. ---
  if (isAgentToken(token)) {
    const agent = await db.agent.findFirst({
      where: { tokenPrefix: tokenPrefix(token), deletedAt: null },
      select: { id: true, clientId: true, enabled: true, tokenHash: true },
    });
    if (!agent?.tokenHash || !verifyToken(token, agent.tokenHash)) throw new HttpError(401, "invalid agent token");
    if (!agent.enabled) throw new HttpError(403, "agent disabled");
    return { id: agent.id, clientId: agent.clientId, via: "per-agent" };
  }

  // --- Shared token (legacy). ---
  if (process.env.RUNNER_REQUIRE_PER_AGENT === "true") throw new HttpError(401, "per-agent token required");
  const shared = process.env.RUNNER_API_TOKEN;
  if (!shared || !safeEqual(token, shared)) throw new HttpError(401, "unauthorized");
  if (!claimedAgentId) throw new HttpError(401, "agentId required with the shared token");
  const agent = await db.agent.findFirst({
    where: { id: claimedAgentId, deletedAt: null },
    select: { id: true, clientId: true, enabled: true, tokenConfirmedAt: true },
  });
  if (!agent) throw new HttpError(404, "unknown agent");
  if (!agent.enabled) throw new HttpError(403, "agent disabled");
  if (agent.tokenConfirmedAt) throw new HttpError(401, "this agent has a per-agent token; the shared token is refused");
  return { id: agent.id, clientId: agent.clientId, via: "shared" };
}
