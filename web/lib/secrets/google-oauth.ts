import { randomBytes, createHash } from "node:crypto";

// gcloud CLI's published installed-app OAuth client (public — "notsosecret" by Google's own
// naming). Verified against google-cloud-sdk's lib/googlecloudsdk/core/config.py
// (CLOUDSDK_CLIENT_ID / CLOUDSDK_CLIENT_NOTSOSECRET).
export const GCLOUD_CLIENT_ID = "32555940559.apps.googleusercontent.com";
export const GCLOUD_CLIENT_SECRET = "ZmssLNjJy2998hD4CTg2ejr2"; // public installed-app "notsosecret"
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const OAUTH_REDIRECT_URI = "http://127.0.0.1:8765/oauth2callback"; // loopback; never actually served

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export type PkcePair = { verifier: string; challenge: string };

export function makePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(challenge: string, loginHint: string): string {
  const params = new URLSearchParams({
    client_id: GCLOUD_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: CLOUD_PLATFORM_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "online",
    prompt: "consent",
    login_hint: loginHint,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: GCLOUD_CLIENT_ID,
      client_secret: GCLOUD_CLIENT_SECRET,
      redirect_uri: OAUTH_REDIRECT_URI,
    });
    const res = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || typeof d?.access_token !== "string") {
      // Never echo the raw body or a token value — only Google's own `error` field (or a bare
      // HTTP status when the body doesn't even have that).
      const errorField = typeof d?.error === "string" ? d.error : undefined;
      return { ok: false, error: errorField ?? `HTTP ${res.status}` };
    }
    return { ok: true, accessToken: d.access_token };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
