// Which request paths are MACHINE endpoints (bearer-gated) vs the small OPEN bootstrap surface.
//
// This is the app's outermost trust boundary, so it lives in lib/ where the test suite can reach it
// (middleware.ts is outside the `lib/**/*.test.ts` glob — a regression there would ship unnoticed).
//
// The rule: everything under /api/runner/ is a machine API for an ALREADY-ENROLLED agent, which does
// send the bearer. The ONLY exceptions are the bootstrap paths a host must fetch before it has a
// token (installer + bundle). Two routes under that prefix — the conn-test credential broker and the
// cloud-group claim — return RESOLVED Delinea secret values, so the prefix must never be blanket-open.
//
// Allowlist, not a prefix match: a new credential-carrying route added under /api/runner/ is gated by
// default instead of silently inheriting the open bootstrap surface.

export const RUNNER_BOOTSTRAP_OPEN = [
  "/api/runner/manifest",
  "/api/runner/file",
  "/api/runner/install.ps1",
  "/api/runner/troubleshoot.ps1",
];

/** Paths served WITHOUT any auth — a host with no token yet must be able to install and self-update. */
export function isRunnerBootstrap(p: string): boolean {
  return RUNNER_BOOTSTRAP_OPEN.includes(p);
}

/**
 * Paths that require the runner bearer token.
 *
 * NOTE: /api/agents (exact) is enrollment — NOT bearer-gated here (a brand-new agent has no token
 * yet; it's gated in-handler by the enroll token). Only the /api/agents/* sub-paths (heartbeat,
 * ad-objects, …) are bearer-gated — those are called by already-enrolled agents that carry the token.
 */
export function isRunnerApi(p: string): boolean {
  return (
    p.startsWith("/api/agents/") ||
    p === "/api/jobs/claim" ||
    /^\/api\/jobs\/[^/]+\/(credential|result|progress)$/.test(p) ||
    (p.startsWith("/api/runner/") && !isRunnerBootstrap(p))
  );
}

/**
 * Routes whose RESPONSE BODY carries resolved Delinea secret values (tenant id, app id, client
 * secret …). These fail closed even in dev: the rest of the runner API tolerates a missing
 * RUNNER_API_TOKEN so a local runner works without one, but "no token configured" must never mean
 * "hand tenant-admin credentials to an unauthenticated caller". A 503 is the correct answer.
 */
export function isSecretBearing(p: string): boolean {
  return (
    /^\/api\/jobs\/[^/]+\/credential$/.test(p) ||
    /^\/api\/runner\/conn-tests\/[^/]+\/credential$/.test(p) ||
    p === "/api/runner/cloud-groups/claim"
  );
}
