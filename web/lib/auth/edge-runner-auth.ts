// Coarse edge decision for runner-API paths. The Edge runtime has NO DB, so per-agent tokens can only
// be VALIDATED in-handler (authenticateAgent). Here we just decide whether to let the request reach the
// handler. Per-agent tokens pass through only once RUNNER_PER_AGENT_EDGE_ENABLED is on (the handler
// wiring that validates them has shipped) or we have reached the RUNNER_REQUIRE_PER_AGENT cutover;
// until then an agt_ bearer is treated like any other non-shared bearer. The shared token keeps its
// fast edge check until the cutover, after which only per-agent tokens are admitted.
// Import from the crypto-free scheme module (NOT ./agent-token, which pulls in `node:crypto` and
// cannot be bundled into the Edge runtime that middleware runs in).
import { isAgentToken } from "@/lib/runner/agent-token-scheme";

export function edgeRunnerAuthDecision(input: {
  bearer: string | null;
  sharedToken: string | undefined;
  requirePerAgent: boolean;
  perAgentEdgeEnabled: boolean;
  secretBearing: boolean;
  prod: boolean;
}): { action: "pass" } | { action: "reject"; status: 401 | 503 } {
  const { bearer, sharedToken, requirePerAgent, perAgentEdgeEnabled, secretBearing, prod } = input;

  // Per-agent tokens are validated in the handler. Admit them at the edge ONLY once the handler
  // wiring is live (RUNNER_PER_AGENT_EDGE_ENABLED) or we have cut over to requiring them. Until then an
  // agt_-prefixed bearer is treated like any other non-shared bearer (falls through -> rejected), so
  // this edge change cannot open an unauthenticated path before the route handlers validate the token.
  if (bearer && isAgentToken(bearer) && (perAgentEdgeEnabled || requirePerAgent)) return { action: "pass" };

  // From here down the caller is presenting the shared token, garbage, or an agt_ token that the edge
  // is not yet configured to admit.
  if (requirePerAgent) return { action: "reject", status: 401 }; // shared token no longer accepted

  if (!sharedToken) {
    // No shared token configured. A secret-bearing route (or prod) must fail CLOSED — "not configured"
    // must never serve tenant-admin credentials to an unauthenticated caller.
    if (secretBearing || prod) return { action: "reject", status: 503 };
    return { action: "pass" }; // dev/tunnel convenience for non-secret routes, unchanged from today
  }

  if (!bearer || bearer !== sharedToken) return { action: "reject", status: 401 };
  return { action: "pass" };
}
