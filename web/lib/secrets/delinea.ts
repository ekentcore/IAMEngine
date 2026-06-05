// App-side Delinea preflight: resolve a secret REFERENCE (id) far enough to prove the app's service
// account can read it, WITHOUT pulling the value into the app. This is the first slice of the
// eventual broker-to-Delinea wiring (runner-service.brokerCredential is still reference-only); for
// now it powers the "test connection" button on the per-client secrets panel.
//
// Mirrors the runner's Coretelligent.Secrets module: OAuth2 password grant against /oauth2/token,
// then GET /api/v1/secrets/{id}. We read only the secret's name (a label) off the response and
// discard everything else — the value never enters a return shape, a log, or the browser.
import { secretIsSet } from "./wiring";

export type DelineaConfig = { baseUrl: string; username: string; password: string };
export type SecretCheck = { ok: boolean; label?: string; error?: string };

// Minimal response shape so the same code works with global fetch and an injected fake in tests.
export type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export function delineaConfigFromEnv(): DelineaConfig {
  return {
    baseUrl: (process.env.DELINEA_BASE_URL ?? "").replace(/\/+$/, ""),
    username: process.env.DELINEA_USER ?? "",
    password: process.env.DELINEA_PASSWORD ?? "",
  };
}

export function delineaConfigured(c: DelineaConfig): boolean {
  return Boolean(c.baseUrl && c.username && c.password);
}

const defaultFetcher: Fetcher = (url, init) => fetch(url, init) as unknown as Promise<FetchResponse>;

// Exchange the app's bootstrap creds for an access token. Exported so a batch ("Test all") can
// fetch ONE token and reuse it across many checkSecret calls instead of one login per secret —
// otherwise N wired secrets = N concurrent password-grants, which trips Delinea rate limits.
export async function getDelineaToken(cfg: DelineaConfig, fetcher: Fetcher = defaultFetcher): Promise<string> {
  const body = new URLSearchParams({ grant_type: "password", username: cfg.username, password: cfg.password }).toString();
  const res = await fetcher(`${cfg.baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Delinea auth failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Delinea auth returned no token");
  return json.access_token;
}

// Resolve a single reference to a pass/fail. Never throws to the caller — returns a readable error.
// Pass `token` to reuse a batch-fetched access token (see getDelineaToken).
export async function checkSecret(cfg: DelineaConfig, externalId: string, fetcher: Fetcher = defaultFetcher, token?: string): Promise<SecretCheck> {
  if (!secretIsSet(externalId)) return { ok: false, error: "not set" };
  if (!delineaConfigured(cfg)) return { ok: false, error: "Delinea not configured (set DELINEA_* on the app)" };
  try {
    const accessToken = token ?? (await getDelineaToken(cfg, fetcher));
    const res = await fetcher(`${cfg.baseUrl}/api/v1/secrets/${encodeURIComponent(externalId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) return { ok: false, error: "not found in Delinea" };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "access denied — grant this account Read on the secret" };
    if (!res.ok) {
      // Secret Server returns 400 with errorCode "API_AccessDenied" for a secret the account can't
      // read (existence is hidden), so surface that as access-denied rather than a bare "400".
      const detail = (await res.json().catch(() => null)) as { errorCode?: string; message?: string } | null;
      if (detail?.errorCode === "API_AccessDenied" || /access denied/i.test(detail?.message ?? "")) {
        return { ok: false, error: "access denied — grant this account Read on the secret in Delinea" };
      }
      return { ok: false, error: `Delinea ${res.status}${detail?.message ? ` — ${detail.message}` : ""}` };
    }
    const body = (await res.json()) as { name?: string };
    // Only the secret's name is surfaced — a human label. The value/items are intentionally dropped.
    return { ok: true, label: typeof body?.name === "string" ? body.name : undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
