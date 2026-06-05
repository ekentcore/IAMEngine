// App-side Delinea broker. Two depths of resolution against the same Secret Server REST API
// (OAuth2 password grant on /oauth2/token, then GET /api/v1/secrets/{id}):
//   - checkSecret        — metadata only (/summary). Proves the app's account can read the
//                          reference WITHOUT pulling the value. Powers the "test connection" button.
//   - resolveSecretFields — the full value (flattened fields). The app resolves the credential and
//                          pushes it down to the runner over the authenticated job channel, so the
//                          runner never needs Delinea creds of its own. The value is held only for
//                          the response — never logged, never persisted.
import { secretIsSet } from "./wiring";

export type DelineaConfig = { baseUrl: string; username: string; password: string };
export type SecretCheck = { ok: boolean; label?: string; error?: string };
// resolveSecretFields returns the secret VALUE (flattened fields) — unlike SecretCheck, which is
// metadata-only. Used by the broker to push the credential down to the runner.
export type SecretFields = { ok: boolean; fields?: Record<string, string>; label?: string; error?: string };

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
    // Use the metadata-only /summary endpoint: it proves the account can resolve the reference and
    // returns the secret's name, but carries NO field values — so the secret value never enters the
    // app, and a "require comment on view" policy isn't triggered (that's a real value-view).
    const res = await fetcher(`${cfg.baseUrl}/api/v1/secrets/${encodeURIComponent(externalId)}/summary`, {
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

// Resolve a reference to its FIELD VALUES (Username/Password/Server/...). This DOES pull the value
// into the app — intentionally — so the broker can push it down to the runner. Caller must treat
// the result as sensitive: never log it, never persist it, hand it straight back over TLS.
export async function resolveSecretFields(cfg: DelineaConfig, externalId: string, fetcher: Fetcher = defaultFetcher, token?: string): Promise<SecretFields> {
  if (!secretIsSet(externalId)) return { ok: false, error: "not set" };
  if (!delineaConfigured(cfg)) return { ok: false, error: "Delinea not configured (set DELINEA_* on the app)" };
  try {
    const accessToken = token ?? (await getDelineaToken(cfg, fetcher));
    // Full secret read (not /summary). autoComment satisfies a "require comment on view" policy —
    // this IS a value view — and is harmless for secrets without the policy.
    const comment = encodeURIComponent("iam-engine automated provisioning");
    const res = await fetcher(`${cfg.baseUrl}/api/v1/secrets/${encodeURIComponent(externalId)}?autoComment=${comment}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) return { ok: false, error: "not found in Delinea" };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "access denied — grant this account Read on the secret" };
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { errorCode?: string; message?: string } | null;
      if (detail?.errorCode === "API_AccessDenied" || /access denied/i.test(detail?.message ?? "")) {
        return { ok: false, error: "access denied — grant this account Read on the secret in Delinea" };
      }
      return { ok: false, error: `Delinea ${res.status}${detail?.message ? ` — ${detail.message}` : ""}` };
    }
    // Flatten Secret Server's item collection into fieldName -> itemValue (same mapping the runner's
    // Coretelligent.Secrets module used to do locally).
    const body = (await res.json()) as { name?: string; items?: Array<{ fieldName?: string; itemValue?: unknown }> };
    const fields: Record<string, string> = {};
    for (const it of body.items ?? []) {
      // Keep every named field; coerce non-string values (numbers, etc.) rather than dropping them.
      // Skip only null/undefined (a genuinely blank field) so the key's absence is meaningful.
      if (typeof it.fieldName === "string" && it.itemValue != null) fields[it.fieldName] = String(it.itemValue);
    }
    return { ok: true, fields, label: typeof body.name === "string" ? body.name : undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
