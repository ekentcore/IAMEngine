// Per-agent runner token: an opaque high-entropy secret. The token IS the agent's identity —
// authenticateAgent() resolves it to exactly one Agent row. We store only sha256(token); the
// plaintext is returned once (on mint) and never persisted. SHA-256 (not bcrypt/scrypt) is correct
// here: the token is 256 bits of randomness, not a guessable password.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const SCHEME = "agt_";
const PREFIX_LEN = SCHEME.length + 8; // "agt_" + 8 chars = 12

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LEN);
}

export function isAgentToken(bearer: string): boolean {
  return typeof bearer === "string" && bearer.startsWith(SCHEME);
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
