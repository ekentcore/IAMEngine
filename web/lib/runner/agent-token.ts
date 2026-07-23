// Per-agent runner token: an opaque high-entropy secret. The token IS the agent's identity —
// authenticateAgent() resolves it to exactly one Agent row. We store only sha256(token); the
// plaintext is returned once (on mint) and never persisted. SHA-256 (not bcrypt/scrypt) is correct
// here: the token is 256 bits of randomness, not a guessable password.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { SCHEME, tokenPrefix } from "./agent-token-scheme";

// Re-export the edge-safe helpers so existing Node-side importers of this module keep working.
export { SCHEME, PREFIX_LEN, isAgentToken, tokenPrefix } from "./agent-token-scheme";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateAgentToken(): { token: string; prefix: string; hash: string } {
  const token = SCHEME + randomBytes(32).toString("base64url");
  return { token, prefix: tokenPrefix(token), hash: hashToken(token) };
}

export function verifyToken(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
