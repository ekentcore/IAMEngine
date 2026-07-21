// Verify a freshly-provisioned Google service account can actually impersonate the tenant's super
// admin via domain-wide delegation (DWD). Google's admin console propagates a newly-granted DWD
// scope grant asynchronously — the first few token exchanges after granting it typically fail with
// `unauthorized_client` or `access_denied` (sometimes surfaced as a bare HTTP 403) before the grant
// takes effect. `probeWithDwdRetry` absorbs that propagation delay; every other failure (bad key,
// wrong admin, revoked SA, ...) fails fast so the caller doesn't sit through 8 useless attempts.
//
// Same house style as provision-google-workspace.ts: injected `fetcher`, never throw, `{ok:false,
// error}` on any terminal failure. Secret hygiene: the private key and any minted access/ID token
// are never interpolated into an error string — errors are built only from Google's own `error`
// field (string or {message}) or a bare `HTTP {status}` fallback.

import { createSign } from "node:crypto";

export const DWD_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.orgunit",
  "https://www.googleapis.com/auth/admin.directory.user.security",
] as const;

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DIRECTORY_USERS_URL = "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=1";

const DEFAULT_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 15_000;

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

// RS256-sign a service-account JWT assertion for the OAuth2 JWT-bearer grant (RFC 7523 / Google's
// service account flow). `nowSec` is injectable so tests can pin `iat`/`exp` instead of racing the
// clock.
export function signSaJwt(input: {
  saEmail: string;
  impersonate: string;
  privateKeyPem: string;
  scopes: readonly string[];
  nowSec?: number;
}): string {
  const iat = input.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = iat + 3600;

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: input.saEmail,
    sub: input.impersonate,
    aud: TOKEN_ENDPOINT,
    scope: input.scopes.join(" "),
    iat,
    exp,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const claimsB64 = base64url(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(input.privateKeyPem);

  return `${signingInput}.${base64url(signature)}`;
}

// Decode a base64-encoded Google service-account JSON key file into just the two fields the JWT
// signer needs. Returns null (never throws) on anything that isn't a well-formed key file —
// invalid base64, invalid JSON, or a JSON object missing either field.
export function keyPemFromBase64Json(keyBase64: string): { saEmail: string; privateKeyPem: string } | null {
  try {
    const json = Buffer.from(keyBase64, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const saEmail = parsed.client_email;
    const privateKeyPem = parsed.private_key;
    if (typeof saEmail !== "string" || !saEmail || typeof privateKeyPem !== "string" || !privateKeyPem) {
      return null;
    }
    return { saEmail, privateKeyPem };
  } catch {
    return null;
  }
}

type CallResult = { status: number; body: Record<string, unknown> | null };

async function callJson(url: string, init: RequestInit, fetcher: typeof fetch): Promise<CallResult> {
  try {
    const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await res.text().catch(() => "");
    let parsed: Record<string, unknown> | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

function ok2xx(r: CallResult): boolean {
  return r.status >= 200 && r.status < 300;
}

// Google's token-endpoint error shape is `{ error: "invalid_grant", error_description: "..." }`
// (a bare string, unlike the `{error:{message}}` shape used by most other Google APIs). The
// Directory API uses the latter. Handle both without ever surfacing the raw body.
function googleErr(r: CallResult): string {
  const err = r.body?.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return `HTTP ${r.status}`;
}

// The specific set of token-exchange errors that mean "DWD grant hasn't propagated yet" rather
// than "this will never work". Anything else (invalid_grant, invalid_client, a malformed key, ...)
// is a terminal failure the caller shouldn't retry. Checked only against the token-exchange
// CallResult — a Directory-API-side failure is never a propagation signal.
function isDwdPropagationError(r: CallResult): boolean {
  if (r.status === 403) return true;
  const err = r.body?.error;
  return err === "unauthorized_client" || err === "access_denied";
}

// Shared implementation behind the exported probeGoogleDirectory. Carries an extra `retryable`
// flag (set only on a token-exchange failure that looks like DWD propagation lag) so
// probeWithDwdRetry can make its retry decision without re-deriving it from an error string, and
// without a second token exchange. The public wrapper below strips that field to match the
// binding exported signature.
async function probeGoogleDirectoryInternal(input: {
  keyBase64: string;
  impersonate: string;
  fetcher?: typeof fetch;
  nowSec?: number;
}): Promise<{ ok: true; customerId?: string } | { ok: false; error: string; retryable: boolean }> {
  const fetcher = input.fetcher ?? fetch;

  const key = keyPemFromBase64Json(input.keyBase64);
  if (!key) return { ok: false, error: "invalid service account key file", retryable: false };

  let jwt: string;
  try {
    jwt = signSaJwt({
      saEmail: key.saEmail,
      impersonate: input.impersonate,
      privateKeyPem: key.privateKeyPem,
      scopes: DWD_SCOPES,
      nowSec: input.nowSec,
    });
  } catch {
    return { ok: false, error: "failed to sign service account JWT", retryable: false };
  }

  const tokenBody = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const tokenRes = await callJson(
    TOKEN_ENDPOINT,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tokenBody.toString() },
    fetcher
  );
  if (!ok2xx(tokenRes) || typeof tokenRes.body?.access_token !== "string") {
    if (!ok2xx(tokenRes)) return { ok: false, error: googleErr(tokenRes), retryable: isDwdPropagationError(tokenRes) };
    return { ok: false, error: "token response missing access_token", retryable: false };
  }
  const accessToken = tokenRes.body.access_token;

  const usersRes = await callJson(
    DIRECTORY_USERS_URL,
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    fetcher
  );
  if (!ok2xx(usersRes)) {
    return { ok: false, error: `directory probe: ${googleErr(usersRes)}`, retryable: false };
  }

  const users = usersRes.body?.users as { customerId?: unknown }[] | undefined;
  const first = Array.isArray(users) ? users[0] : undefined;
  const customerId = typeof first?.customerId === "string" ? first.customerId : undefined;

  return customerId ? { ok: true, customerId } : { ok: true };
}

export async function probeGoogleDirectory(input: {
  keyBase64: string;
  impersonate: string;
  fetcher?: typeof fetch;
  nowSec?: number;
}): Promise<{ ok: true; customerId?: string } | { ok: false; error: string }> {
  const result = await probeGoogleDirectoryInternal(input);
  if (result.ok) return result;
  return { ok: false, error: result.error };
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

// Retry probeGoogleDirectory across DWD's propagation delay. Only retries the specific token-
// exchange failures that mean "grant hasn't taken effect yet" (unauthorized_client, access_denied,
// or a bare HTTP 403) — everything else (bad key, wrong admin, revoked SA, a Directory-API-side
// failure) fails immediately on the first attempt.
export async function probeWithDwdRetry(
  input: Parameters<typeof probeGoogleDirectory>[0],
  opts?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<{ ok: boolean; customerId?: string; error?: string }> {
  const attempts = opts?.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = opts?.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts?.sleep ?? defaultSleep;

  let lastError: string | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await probeGoogleDirectoryInternal(input);
    if (result.ok) return result;

    lastError = result.error;
    if (!result.retryable) return { ok: false, error: result.error };
    if (attempt < attempts - 1) await sleep(delayMs);
  }

  return { ok: false, error: lastError };
}
