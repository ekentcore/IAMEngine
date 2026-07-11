// App-side Delinea broker. Two depths of resolution against the same Secret Server REST API
// (OAuth2 password grant on /oauth2/token, then GET /api/v1/secrets/{id}):
//   - checkSecret        — metadata only (/summary). Proves the app's account can read the
//                          reference WITHOUT pulling the value. Powers the "test connection" button.
//   - resolveSecretFields — the full value (flattened fields). The app resolves the credential and
//                          pushes it down to the runner over the authenticated job channel, so the
//                          runner never needs Delinea creds of its own. The value is held only for
//                          the response — never logged, never persisted.
import { secretIsSet } from "./wiring";
import { defaultSlug } from "./delinea-templates";

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

// ---- WRITE path: create a secret in Secret Server -----------------------------------------------
// Authoring credentials in-app. Strictly opt-in and separate from the read paths above; the caller
// (the /secrets/create route) gates on delineaWriteConfigured() before ever reaching here. The
// values are POSTed once and never persisted/logged by the app — only the returned secret id is.

// A Secret Server template stub item — the shape the create endpoint expects each field in. We fetch
// the stub for the template, drop our values into the matching items by slug, and POST it back so the
// item ids/field ids are always exactly what the template defines (no guessing at fieldId).
type StubItem = { fieldId?: number; slug?: string; fieldName?: string; itemValue?: unknown; [k: string]: unknown };
export type CreateSecretInput = { name: string; folderId: string; templateId: number; fields: Record<string, string> };
export type CreateResult = { ok: boolean; id?: string; error?: string };

// Fill a template stub's items from our slug→value map, preserving every other property Secret Server
// put on each item (fieldId, isFile, ...). Matches on slug, falling back to the slugified field name.
// Returns which of OUR keys never matched a stub item — a non-empty `unmatched` means the template's
// real slugs differ from what we sent, so the values would silently drop; the caller must refuse
// rather than create a secret with blank fields.
export function shapeStubItems(stub: StubItem[], fields: Record<string, string>): { items: StubItem[]; unmatched: string[] } {
  const used = new Set<string>();
  const items = stub.map((it) => {
    const key = it.slug ?? (it.fieldName ? defaultSlug(it.fieldName) : "");
    if (Object.prototype.hasOwnProperty.call(fields, key)) { used.add(key); return { ...it, itemValue: fields[key] }; }
    return it;
  });
  const unmatched = Object.keys(fields).filter((k) => !used.has(k));
  return { items, unmatched };
}

// Best-effort search for an existing secret of this exact name in the folder — the dedup key for
// idempotency (Secret Server has no unique constraint on name). Returns its id, or null (incl. when
// the search itself fails, so a search outage falls through to a normal create rather than blocking).
async function findSecretIdByName(cfg: DelineaConfig, folderId: string | number, name: string, token: string, fetcher: Fetcher): Promise<string | null> {
  try {
    const url = `${cfg.baseUrl}/api/v1/secrets?filter.folderId=${encodeURIComponent(String(folderId))}&filter.includeSubFolders=false&filter.searchText=${encodeURIComponent(name)}&take=50`;
    const res = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const d = (await res.json().catch(() => null)) as { records?: { id?: number | string; name?: string }[] } | null;
    const hit = (d?.records ?? []).find((r) => String(r.name ?? "").trim().toLowerCase() === name.trim().toLowerCase());
    return hit?.id != null ? String(hit.id) : null;
  } catch {
    return null;
  }
}

// POST a new secret. `token` is a write-account access token (getDelineaToken with the write config).
// Never throws to the caller — returns a readable error. Does NOT log the values it sends.
// Idempotent: if a secret of the same name already exists in the folder, its id is returned instead of
// creating a duplicate — so a retry after a lost response can't leave a stray credential in the vault.
export async function createSecret(cfg: DelineaConfig, input: CreateSecretInput, token: string, fetcher: Fetcher = defaultFetcher): Promise<CreateResult> {
  try {
    // 0. Dedup: reuse an existing same-named secret in this folder rather than creating another.
    const existing = await findSecretIdByName(cfg, input.folderId, input.name, token, fetcher);
    if (existing) return { ok: true, id: existing };

    // 1. Pull the template stub to learn the exact item shape (field ids/slugs) for this template.
    const stubRes = await fetcher(`${cfg.baseUrl}/api/v1/secrets/stub?filterSecretTemplateId=${encodeURIComponent(String(input.templateId))}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (stubRes.status === 401 || stubRes.status === 403) return { ok: false, error: "access denied — the write account needs Create + template access in Delinea" };
    if (!stubRes.ok) {
      const d = (await stubRes.json().catch(() => null)) as { message?: string } | null;
      return { ok: false, error: `Delinea stub ${stubRes.status}${d?.message ? ` — ${d.message}` : ""}` };
    }
    const stub = (await stubRes.json()) as { items?: StubItem[] };
    const { items, unmatched } = shapeStubItems(stub.items ?? [], input.fields);
    // Refuse rather than POST a secret whose values silently dropped because the template's field slugs
    // differ from ours — the operator needs to set a fieldMap, not end up with a blank credential.
    if (unmatched.length > 0) {
      return { ok: false, error: `template ${input.templateId} has no field matching: ${unmatched.join(", ")} — set a fieldMap in DELINEA_TEMPLATE_MAP so these land in the right Secret Server fields` };
    }

    // 2. POST the populated stub. folderId is numeric in Secret Server; coerce when it's a numeric string.
    const folderId = Number.isFinite(Number(input.folderId)) ? Number(input.folderId) : input.folderId;
    const body = { name: input.name, folderId, secretTemplateId: input.templateId, items };
    const res = await fetcher(`${cfg.baseUrl}/api/v1/secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "access denied — the write account needs Create on this folder/template in Delinea" };
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { message?: string; errorCode?: string } | null;
      return { ok: false, error: `Delinea ${res.status}${d?.message ? ` — ${d.message}` : ""}` };
    }
    const created = (await res.json()) as { id?: number | string };
    if (created?.id == null) return { ok: false, error: "Delinea create returned no id" };
    return { ok: true, id: String(created.id) };
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
