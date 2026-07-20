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
export type SecretCheck = { ok: boolean; label?: string; error?: string; expiresAt?: string };

// Secret Server exposes secret expiry under different keys across versions — parse defensively from
// a summary/detail body. Accepts an explicit expiration date, or "days until expiration" relative to
// now. Returns an ISO string or undefined (never throws). `now` is injectable for tests.
export function parseDelineaExpiry(body: unknown, now: Date = new Date()): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const o = body as Record<string, unknown>;
  for (const k of ["expirationDate", "secretExpirationDate", "expiration", "expiresOn", "expires"]) {
    const v = o[k];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  }
  for (const k of ["daysUntilExpiration", "daysUntilExpiry", "expirationDays"]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return new Date(now.getTime() + v * 86_400_000).toISOString();
  }
  return undefined;
}
// resolveSecretFields returns the secret VALUE (flattened fields) — unlike SecretCheck, which is
// metadata-only. Used by the broker to push the credential down to the runner.
export type SecretFields = { ok: boolean; fields?: Record<string, string>; label?: string; error?: string; expiresAt?: string };

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
    // Expiry (when Secret Server includes it in the summary) is captured opportunistically.
    return { ok: true, label: typeof body?.name === "string" ? body.name : undefined, expiresAt: parseDelineaExpiry(body) };
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

    // folderId is numeric in Secret Server; coerce when it's a numeric string.
    const folderId = Number.isFinite(Number(input.folderId)) ? Number(input.folderId) : input.folderId;

    // 1. Pull the template stub — both to learn the exact item shape (field ids/slugs) AND to obtain
    //    the full secret model Secret Server expects handed back on create. The stub call needs BOTH
    //    the template id and the target folder: Secret Server (Cloud in particular) 400s with "Folder
    //    is required" / "The request is invalid." on the older `filterSecretTemplateId` form or when
    //    the folder is omitted.
    const stubRes = await fetcher(`${cfg.baseUrl}/api/v1/secrets/stub?secretTemplateId=${encodeURIComponent(String(input.templateId))}&folderId=${encodeURIComponent(String(folderId))}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (stubRes.status === 401 || stubRes.status === 403) return { ok: false, error: "access denied — the write account needs Create + template access in Delinea" };
    if (!stubRes.ok) {
      const d = (await stubRes.json().catch(() => null)) as { message?: string } | null;
      return { ok: false, error: `Delinea stub ${stubRes.status}${d?.message ? ` — ${d.message}` : ""}` };
    }
    const stub = (await stubRes.json()) as { items?: StubItem[]; [k: string]: unknown };
    const { items, unmatched } = shapeStubItems(stub.items ?? [], input.fields);
    // Refuse rather than POST a secret whose values silently dropped because the template's field slugs
    // differ from ours — the operator needs to set a fieldMap, not end up with a blank credential.
    if (unmatched.length > 0) {
      return { ok: false, error: `template ${input.templateId} has no field matching: ${unmatched.join(", ")} — set a fieldMap in DELINEA_TEMPLATE_MAP so these land in the right Secret Server fields` };
    }

    // 2. POST the FULL stub model back, with our name/folder/filled items overlaid. Secret Server
    //    requires the complete model it handed us (siteId, active, policy flags, …); a hand-built
    //    { name, folderId, items } is rejected as "The request is invalid." on Secret Server Cloud.
    const body = { ...stub, name: input.name, folderId, secretTemplateId: input.templateId, items };
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

// PUT a single field's value onto an EXISTING secret. createSecret is find-or-create — when it
// reuses an already-existing same-named secret it does NOT write fields, so this is what actually
// pushes current values onto a secret that already exists (and, called right after a fresh create,
// is a harmless same-value overwrite of what create's stub-fill already set).
//
// Attempts EVERY field, even after an earlier one fails — a torn write (some fields land, some don't)
// must be reported per-field, not silently truncated at the first failure. This matters most for
// OPTIONAL fields (e.g. the cert fields on a password-only Secret Server template, which legitimately
// has no matching slug and 400s on PUT): the caller needs to know exactly which field(s) failed so it
// can decide whether that's fatal (a required field) or a warning (an optional one) — see
// writeProvisionedM365App. `ok` here is true only when every attempted field succeeded; a caller that
// wants to distinguish required-vs-optional failures reads `results` itself.
// Never throws to the caller — returns a readable error per field. Does NOT log the values it sends.
export async function updateSecretFields(
  cfg: DelineaConfig,
  externalId: string,
  fields: Record<string, string>,
  token: string,
  fetcher: Fetcher = defaultFetcher
): Promise<{ ok: boolean; results: { slug: string; ok: boolean; error?: string }[]; error?: string }> {
  const results: { slug: string; ok: boolean; error?: string }[] = [];
  // A field PUT reads the secret to apply the edit, so a "require comment on view" policy rejects it
  // with 400 "requires a comment when viewed" unless we supply one — same policy resolveSecretFields
  // satisfies on the read path. Harmless for secrets without the policy.
  const comment = encodeURIComponent("iam-engine automated provisioning");
  for (const [slug, value] of Object.entries(fields)) {
    try {
      const res = await fetcher(`${cfg.baseUrl}/api/v1/secrets/${encodeURIComponent(externalId)}/fields/${encodeURIComponent(slug)}?autoComment=${comment}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (res.status === 401 || res.status === 403) {
        results.push({ slug, ok: false, error: `access denied updating field "${slug}" — the write account needs Edit on this secret in Delinea` });
        continue;
      }
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { message?: string } | null;
        results.push({ slug, ok: false, error: `Delinea ${res.status} updating field "${slug}"${d?.message ? ` — ${d.message}` : ""}` });
        continue;
      }
      results.push({ slug, ok: true });
    } catch (e) {
      results.push({ slug, ok: false, error: (e as Error).message });
    }
  }
  const ok = results.every((r) => r.ok);
  return { ok, results, error: ok ? undefined : results.filter((r) => !r.ok).map((r) => r.error).join("; ") };
}

// --- One-time password (TOTP) ------------------------------------------------------------------
// Secret Server HOLDS the authenticator seed when "one-time password" is enabled on the secret /
// template, and mints the current code on demand. So we never store a seed in a custom field and
// never handle one: we ask for a 30-second code at the moment it's needed.
//
//   GET /api/v1/one-time-password-code/{secretId}
//   -> { "0": { code: "123456", remainingSeconds: 11, durationSeconds: 30 } }
//
// Keyed by index (a secret can carry several OTP fields); we take the first.
export type OneTimePassword = { ok: boolean; code?: string; remainingSeconds?: number; durationSeconds?: number; error?: string };

// A code with 3s left is useless to a browser login that still has to reach the MFA box. When the
// window is nearly over, WAIT for the next one so the caller always gets a near-full-length code.
const OTP_MIN_SECONDS = 12;

export async function getOneTimePasswordCode(
  cfg: DelineaConfig,
  externalId: string,
  fetcher: Fetcher = defaultFetcher,
  token?: string,
  opts: { waitForFresh?: boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<OneTimePassword> {
  if (!secretIsSet(externalId)) return { ok: false, error: "not set" };
  if (!delineaConfigured(cfg)) return { ok: false, error: "Delinea not configured (set DELINEA_* on the app)" };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    const accessToken = token ?? (await getDelineaToken(cfg, fetcher));
    const fetchOnce = async (): Promise<OneTimePassword> => {
      const res = await fetcher(`${cfg.baseUrl}/api/v1/one-time-password-code/${encodeURIComponent(externalId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      // 404 = this secret has no one-time password configured. That's a SETUP answer, not an error:
      // enable One-Time Password on the secret (paste the authenticator seed there once).
      if (res.status === 404) return { ok: false, error: "no one-time password is configured on this Delinea secret — enable it on the secret (Security > One-Time Password) and paste the authenticator seed there" };
      if (res.status === 401 || res.status === 403) return { ok: false, error: "access denied reading the one-time password — grant this account Read on the secret" };
      if (!res.ok) return { ok: false, error: `Delinea ${res.status}` };
      const body = (await res.json().catch(() => null)) as Record<string, { code?: string; remainingSeconds?: number; durationSeconds?: number }> | null;
      const first = body && typeof body === "object" ? Object.values(body)[0] : null;
      if (!first?.code) return { ok: false, error: "Delinea returned no one-time password code" };
      return { ok: true, code: first.code, remainingSeconds: first.remainingSeconds, durationSeconds: first.durationSeconds };
    };

    let otp = await fetchOnce();
    if (otp.ok && (opts.waitForFresh ?? true) && typeof otp.remainingSeconds === "number" && otp.remainingSeconds < OTP_MIN_SECONDS) {
      await sleep((otp.remainingSeconds + 1) * 1000);
      const fresh = await fetchOnce();
      // The original code is now guaranteed dead (we just slept past its window) — a failed
      // refetch must surface as a failure, never hand back the expired code as ok.
      otp = fresh.ok ? fresh : { ok: false, error: `the current code was about to expire and refreshing it failed: ${fresh.error ?? "unknown error"}` };
    }
    return otp;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// --- Folder access introspection (the Delinea self-check) ---------------------------------------
// Proves the app's account can READ (and, for the write path, CREATE IN) a client's folder without
// ever touching a secret value. Secret Server's folder-permission surface varies by version, so the
// write check is TRI-STATE: "unknown" (couldn't introspect) must never be treated as a failure.

export type FolderRead = { ok: boolean; name?: string; error?: string };
export async function checkFolderRead(cfg: DelineaConfig, folderId: string, fetcher: Fetcher = defaultFetcher, token?: string): Promise<FolderRead> {
  if (!folderId) return { ok: false, error: "no folder id" };
  if (!delineaConfigured(cfg)) return { ok: false, error: "Delinea not configured (set DELINEA_* on the app)" };
  try {
    const accessToken = token ?? (await getDelineaToken(cfg, fetcher));
    const res = await fetcher(`${cfg.baseUrl}/api/v1/folders/${encodeURIComponent(folderId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) return { ok: false, error: `folder ${folderId} not found (or hidden from this account)` };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "access denied — grant the account View on the folder" };
    if (!res.ok) return { ok: false, error: `Delinea ${res.status}` };
    const d = (await res.json().catch(() => null)) as { folderName?: string; name?: string } | null;
    return { ok: true, name: String(d?.folderName ?? d?.name ?? folderId) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type FolderWrite = { write: "ok" | "fail" | "unknown"; detail: string };
export async function checkFolderWrite(cfg: DelineaConfig, folderId: string, fetcher: Fetcher = defaultFetcher, token?: string): Promise<FolderWrite> {
  if (!folderId) return { write: "unknown", detail: "no folder id stored for this client" };
  if (!delineaConfigured(cfg)) return { write: "unknown", detail: "Delinea not configured" };
  try {
    const accessToken = token ?? (await getDelineaToken(cfg, fetcher));
    // Primary: folder-details returns UI capability flags on most Secret Server versions.
    const det = await fetcher(`${cfg.baseUrl}/api/v1/folder-details/${encodeURIComponent(folderId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (det.ok) {
      const d = (await det.json().catch(() => null)) as { actions?: unknown; allowedTemplates?: unknown } | null;
      const actions = Array.isArray(d?.actions) ? (d?.actions as unknown[]).map((a) => String(a).toLowerCase()) : null;
      if (actions) {
        return actions.some((a) => a.includes("createsecret") || a === "addsecret")
          ? { write: "ok", detail: "the account can create secrets in this folder" }
          : { write: "fail", detail: "the account cannot create secrets here — grant it Add Secret/Edit on the folder" };
      }
    }
    if (det.status === 401 || det.status === 403) return { write: "fail", detail: "access denied on the folder — grant the account Add Secret/Edit" };
    // Fallback: the permissions list (needs Owner on some versions — expect "unknown" often).
    const per = await fetcher(`${cfg.baseUrl}/api/v1/folder-permissions?filter.folderId=${encodeURIComponent(folderId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (per.ok) {
      const d = (await per.json().catch(() => null)) as { records?: { userName?: string; folderAccessRoleName?: string; secretAccessRoleName?: string }[] } | null;
      const mine = (d?.records ?? []).filter((r) => String(r.userName ?? "").toLowerCase() === cfg.username.toLowerCase());
      if (mine.length > 0) {
        const roles = mine.map((r) => `${r.folderAccessRoleName ?? ""}/${r.secretAccessRoleName ?? ""}`.toLowerCase());
        return roles.some((r) => r.includes("owner") || r.includes("edit") || r.includes("add"))
          ? { write: "ok", detail: `folder roles: ${roles.join(", ")}` }
          : { write: "fail", detail: `folder roles (${roles.join(", ")}) don't allow creating secrets — grant Add Secret/Edit` };
      }
    }
    return { write: "unknown", detail: "couldn't introspect folder permissions on this Secret Server version — verify Add Secret manually" };
  } catch (e) {
    return { write: "unknown", detail: (e as Error).message };
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
    return { ok: true, fields, label: typeof body.name === "string" ? body.name : undefined, expiresAt: parseDelineaExpiry(body) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
