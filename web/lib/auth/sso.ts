// Microsoft 365 / Entra single sign-on via OIDC Authorization Code + PKCE. Zero external deps:
// Node crypto for PKCE/state, a fetch to Entra's token endpoint, and a payload-decode of the
// id_token (which we receive server-side directly from Microsoft over our authenticated code
// exchange — so it's trustworthy without local JWKS verification; we still check aud + exp).
//
// Config (env, via env.env → web/.env): AZURE_SSO_TENANT_ID, AZURE_SSO_CLIENT_ID,
// AZURE_SSO_CLIENT_SECRET. Register the redirect URI <origin>/api/auth/sso/callback in the app.
import { randomBytes, createHash } from "node:crypto";

// Short-lived cookie holding the PKCE state+verifier during the round-trip. Lives here (not in a
// route file) because Next route modules may only export handlers + a few configs.
export const SSO_COOKIE = "iam_sso";

export type SsoConfig = { tenantId: string; clientId: string; clientSecret: string };

export function ssoConfig(): SsoConfig | null {
  const tenantId = process.env.AZURE_SSO_TENANT_ID ?? "";
  const clientId = process.env.AZURE_SSO_CLIENT_ID ?? "";
  const clientSecret = process.env.AZURE_SSO_CLIENT_SECRET ?? "";
  return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : null;
}

export function ssoEnabled(): boolean {
  return ssoConfig() !== null;
}

// The browser-facing origin. Behind a proxy/tunnel (cloudflared, ngrok) Next may see the internal
// http://localhost host, so AUTH_PUBLIC_ORIGIN forces the public https URL the redirect URI must
// match. Falls back to the request origin for plain localhost use.
export function publicOrigin(req: Request): string {
  const override = process.env.AUTH_PUBLIC_ORIGIN?.trim();
  if (override) return override.replace(/\/$/, "");
  return new URL(req.url).origin;
}

const b64url = (b: Buffer) => b.toString("base64url");

// state binds the round-trip; verifier/challenge are PKCE. The verifier + state ride in a short-
// lived httpOnly cookie; the challenge goes to Entra.
export function newPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  return { verifier, challenge, state };
}

export function authorizeUrl(cfg: SsoConfig, redirectUri: string, state: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: "openid profile email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize?${p}`;
}

export async function exchangeCode(cfg: SsoConfig, code: string, redirectUri: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { id_token?: string; error_description?: string; error?: string };
  if (!res.ok || !json.id_token) throw new Error(json.error_description ?? json.error ?? `token exchange failed (${res.status})`);
  return json.id_token;
}

export type SsoIdentity = { email: string; oid: string; name: string | null };

export function identityFromIdToken(cfg: SsoConfig, idToken: string): SsoIdentity {
  const part = idToken.split(".")[1];
  if (!part) throw new Error("malformed id_token");
  const claims = JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
  // We received this token directly from Entra's token endpoint over TLS during our authenticated
  // code exchange, so it's trustworthy — but still sanity-check audience + expiry.
  if (claims.aud !== cfg.clientId) throw new Error("id_token audience mismatch");
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) throw new Error("id_token expired");
  const email = String((claims.email ?? claims.preferred_username ?? claims.upn ?? "")).toLowerCase();
  const oid = String(claims.oid ?? claims.sub ?? "");
  if (!email || !oid) throw new Error("id_token missing email/oid");
  return { email, oid, name: claims.name ? String(claims.name) : null };
}
