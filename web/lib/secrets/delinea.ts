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

async function getToken(cfg: DelineaConfig, fetcher: Fetcher): Promise<string> {
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
export async function checkSecret(cfg: DelineaConfig, externalId: string, fetcher: Fetcher = defaultFetcher): Promise<SecretCheck> {
  if (!secretIsSet(externalId)) return { ok: false, error: "not set" };
  if (!delineaConfigured(cfg)) return { ok: false, error: "Delinea not configured (set DELINEA_* on the app)" };
  try {
    const token = await getToken(cfg, fetcher);
    const res = await fetcher(`${cfg.baseUrl}/api/v1/secrets/${encodeURIComponent(externalId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { ok: false, error: "not found in Delinea" };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "access denied (check the app's Delinea permissions)" };
    if (!res.ok) return { ok: false, error: `Delinea ${res.status}` };
    const body = (await res.json()) as { name?: string };
    // Only the secret's name is surfaced — a human label. The value/items are intentionally dropped.
    return { ok: true, label: typeof body?.name === "string" ? body.name : undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
