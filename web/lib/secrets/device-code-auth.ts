export const DEVICE_CODE_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"; // Microsoft Graph PowerShell (public client, device-code capable)
// offline_access intentionally omitted: the refresh_token it would grant is discarded — only the
// ~1h access token is returned/used, and device-code provisioning completes well within that.
export const DEVICE_CODE_SCOPES = "Application.ReadWrite.All AppRoleAssignment.ReadWrite.All RoleManagement.ReadWrite.Directory Directory.ReadWrite.All";
const AUTH_HOST = "https://login.microsoftonline.com";
const PENDING = new Set(["authorization_pending", "slow_down"]);

export async function startDeviceCode(tenant: string, fetcher: typeof fetch = fetch): Promise<
  { ok: true; deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number } | { ok: false; error: string }> {
  try {
    const body = new URLSearchParams({ client_id: DEVICE_CODE_CLIENT_ID, scope: DEVICE_CODE_SCOPES });
    const res = await fetcher(`${AUTH_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(20_000),
    });
    const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !d?.device_code) return { ok: false, error: String(d?.error_description ?? d?.error ?? `HTTP ${res.status}`) };
    return { ok: true, deviceCode: String(d.device_code), userCode: String(d.user_code), verificationUri: String(d.verification_uri), interval: Number(d.interval ?? 5), expiresIn: Number(d.expires_in ?? 900) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function pollDeviceCodeToken(
  tenant: string, deviceCode: string,
  opts: { intervalSeconds: number; expiresInSeconds: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
  fetcher: typeof fetch = fetch
): Promise<{ ok: true; token: string } | { ok: false; error: string; code?: string }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  let interval = Math.max(1, opts.intervalSeconds);
  const deadline = now() + opts.expiresInSeconds * 1000;
  // A persistent egress outage (network down, DNS, TLS, the 20s AbortSignal.timeout firing) throws
  // on every attempt — that's an infra problem, not "still pending", and must not be allowed to burn
  // the whole device-code deadline silently misreported as expired_token.
  const CONSECUTIVE_FAILURE_LIMIT = 4;
  let consecutiveFailures = 0;
  let lastFailureMessage = "";
  while (now() < deadline) {
    await sleep(interval * 1000);
    try {
      const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: DEVICE_CODE_CLIENT_ID, device_code: deviceCode });
      const res = await fetcher(`${AUTH_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(20_000),
      });
      consecutiveFailures = 0; // a response was received, regardless of status — the outage (if any) is over
      const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && d?.access_token) return { ok: true, token: String(d.access_token) };
      // A well-formed OAuth error code drives the decision. Anything else — an unparseable body (an
      // HTML gateway page) or a non-OAuth error shape (Azure's nested {"error":{"code":...}}, where
      // `error` is an object so `code` reads undefined) — is retryable ONLY on a retryable-looking
      // HTTP status (429/5xx). A terminal 4xx with no recognizable OAuth error code is NOT retried —
      // looping it for the full device-code lifetime just delays an already-final failure.
      const code = typeof d?.error === "string" ? d.error : undefined;
      const retryable = (code !== undefined && PENDING.has(code)) || res.status === 429 || res.status >= 500;
      if (retryable) {
        if (code === "slow_down") interval += 5;
        continue;
      }
      if (code === undefined) {
        return { ok: false, error: `unexpected response from the token endpoint (HTTP ${res.status})`, code: `http_${res.status}` };
      }
      return { ok: false, error: String(d?.error_description ?? code), code }; // declined / expired / bad_verification_code
    } catch (e) {
      consecutiveFailures++;
      lastFailureMessage = (e as Error)?.message ?? String(e);
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        return { ok: false, error: lastFailureMessage, code: "network_error" };
      }
    }
  }
  return { ok: false, error: "device code expired before sign-in completed", code: "expired_token" };
}
