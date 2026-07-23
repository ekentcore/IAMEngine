// Edge-safe pieces of the per-agent runner token: the scheme prefix and the pure string helpers.
// These carry NO `node:crypto` dependency, so they can be imported from the Edge runtime (middleware
// via lib/auth/edge-runner-auth). The crypto-bearing mint/hash/verify functions live in ./agent-token,
// which is Node-only. Keep this module dependency-free.

export const SCHEME = "agt_";
export const PREFIX_LEN = SCHEME.length + 8; // "agt_" + 8 chars = 12

export function isAgentToken(bearer: string): boolean {
  return typeof bearer === "string" && bearer.startsWith(SCHEME);
}

export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LEN);
}
