// Short-lived, self-describing enrollment token for the one-line runner installer. The /agents UI
// mints one bound to a (scope, client); the installer hands it back to POST /api/agents, which
// verifies the HMAC + expiry and enrolls with the embedded scope/client — so a token can only ever
// register the agent it was minted for, and only briefly. Stateless (no DB): HMAC over the payload.
import { createHmac, timingSafeEqual } from "node:crypto";

export type EnrollClaims = { scope: "central" | "client_network"; client: string | null; exp: number };

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function enrollSecret(): string {
  // A dedicated secret if set, else reuse the app's JWT secret; never empty (dev fallback).
  return process.env.RUNNER_ENROLL_SECRET || process.env.JWT_SECRET_KEY || "iam-engine-dev-enroll-secret";
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

// Mint a token valid for ttlSeconds. `nowMs` is injectable for tests.
export function mintEnrollToken(
  input: { scope: EnrollClaims["scope"]; client: string | null; ttlSeconds?: number },
  secret: string,
  nowMs: number
): string {
  const claims: EnrollClaims = {
    scope: input.scope,
    client: input.client ?? null,
    exp: Math.floor(nowMs / 1000) + (input.ttlSeconds ?? 3600),
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return `v1.${payload}.${sign(payload, secret)}`;
}

// Verify signature + expiry; return the claims or null. Never throws.
export function verifyEnrollToken(token: string, secret: string, nowMs: number): EnrollClaims | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload, sig] = parts;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: EnrollClaims;
  try {
    claims = JSON.parse(unb64url(payload).toString("utf8")) as EnrollClaims;
  } catch {
    return null;
  }
  if (claims.scope !== "central" && claims.scope !== "client_network") return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < nowMs) return null;
  return claims;
}
