// Read what an app registration has actually been GRANTED in Graph, and who is still disabled but
// holding a licence. Both are app-only reads over a client-credentials token.
//
// This is the TypeScript port of Get-CtgGrantedGraphAppRoles / Invoke-CtgGraphReadRetry in
// runner/Start-IamRunner.ps1. It keeps the property that PR #90 was written to establish, because the
// whole point of an audit is that its "missing" column is trustworthy:
//
//   a read that FAILED must never be reported as "granted nothing".
//
// Graph throttles (429) hard when several tenants are read back-to-back, which is exactly what a fleet
// sweep does. The runner's original bug was a silent `catch {}` around the role-name lookup: one
// throttled response and every Graph permission vanished from the result, producing a confident,
// totally wrong "all permissions missing". So: retry, and track what could not be resolved
// (`complete` / `unresolved`) so the caller can say "couldn't verify" instead of "missing".
import { GRAPH_RESOURCE_APP_ID } from "./graph-caps";

const GRAPH = "https://graph.microsoft.com/v1.0";
const RETRYABLE = /^(429|5\d\d)$/;

export type GraphFetch = typeof fetch;

// Retry shape. `backoff` is injectable so tests exercise the retry PATH without paying its wall clock
// (a persistent 429 otherwise costs 14 real seconds per case).
export type GraphRetryOpts = { maxAttempts?: number; backoff?: (attempt: number) => number };
const DEFAULT_BACKOFF = (attempt: number): number => Math.min(8000, 2 ** attempt * 1000);

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

// A read-only Graph GET with backoff. Retries throttling and transient server errors; a 403/404 is a
// real answer and comes straight back.
export async function graphGet<T>(
  token: string,
  url: string,
  fetcher: GraphFetch = fetch,
  opts: GraphRetryOpts = {}
): Promise<{ ok: true; body: T } | { ok: false; status: number; error: string }> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let last = { ok: false as const, status: 0, error: "no attempt made" };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoff(attempt));
    try {
      const res = await fetcher(url.startsWith("http") ? url : `${GRAPH}${url}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return { ok: true, body: (await res.json()) as T };
      const text = await res.text().catch(() => "");
      last = { ok: false, status: res.status, error: text.slice(0, 300) || `HTTP ${res.status}` };
      if (!RETRYABLE.test(String(res.status))) return last;
    } catch (e) {
      // Network/timeout: worth another go.
      last = { ok: false, status: 0, error: (e as Error).message };
    }
  }
  return last;
}

type AppRoleAssignment = { appRoleId?: string; resourceId?: string };
type AppRole = { id?: string; value?: string };

export type GrantedRolesResult = {
  ok: boolean;
  roles: string[]; // resolved app-role NAMES, e.g. User.ReadWrite.All
  complete: boolean; // false = at least one assignment could not be resolved to a name
  unresolved: number;
  error?: string;
};

// Every app role granted to this app registration, by name.
//
//   1. the app's own service principal -> its appRoleAssignments (each = { resourceId, appRoleId })
//   2. per distinct resourceId, the RESOURCE service principal's appRoles -> id->value map
//   3. map each assignment's appRoleId through it
//
// Step 2 is the fragile one, and the reason `complete` exists: if a resource SP read fails we count it
// as unresolved instead of silently dropping its roles.
export async function readGrantedAppRoles(token: string, appId: string, fetcher: GraphFetch = fetch, opts: GraphRetryOpts = {}): Promise<GrantedRolesResult> {
  const assignments = await graphGet<{ value?: AppRoleAssignment[] }>(
    token,
    `/servicePrincipals(appId='${encodeURIComponent(appId)}')/appRoleAssignments?$top=200`,
    fetcher,
    opts
  );
  if (!assignments.ok) {
    // Reading our OWN assignments can 403 when the app lacks Application.Read.All/Directory.Read.All.
    // That is "cannot verify", NOT "has nothing" — saying otherwise would report every permission as
    // missing on a perfectly healthy tenant.
    return { ok: false, roles: [], complete: false, unresolved: 0, error: assignments.error };
  }
  const rows = assignments.body.value ?? [];
  if (rows.length === 0) return { ok: true, roles: [], complete: true, unresolved: 0 }; // consented to nothing

  const roleMaps = new Map<string, Map<string, string> | null>(); // resourceId -> (roleId -> name), null = unreadable
  for (const resourceId of new Set(rows.map((r) => r.resourceId).filter((x): x is string => Boolean(x)))) {
    const sp = await graphGet<{ appRoles?: AppRole[] }>(token, `/servicePrincipals/${encodeURIComponent(resourceId)}?$select=appRoles`, fetcher, opts);
    if (!sp.ok) {
      roleMaps.set(resourceId, null); // unreadable — remember that, do NOT treat as empty
      continue;
    }
    roleMaps.set(resourceId, new Map((sp.body.appRoles ?? []).map((r) => [String(r.id), String(r.value)])));
  }

  const names = new Set<string>();
  let unresolved = 0;
  for (const r of rows) {
    const map = r.resourceId ? roleMaps.get(r.resourceId) : undefined;
    if (map == null) {
      unresolved++; // the read failed, or the assignment has no resource — either way we don't know
      continue;
    }
    const name = r.appRoleId ? map.get(String(r.appRoleId)) : undefined;
    if (name) names.add(name);
    else unresolved++;
  }
  return { ok: true, roles: [...names].sort(), complete: unresolved === 0, unresolved };
}

export type DisabledLicensedUser = {
  id: string;
  displayName: string;
  userPrincipalName: string;
  skuIds: string[];
};

// Users whose sign-in is blocked but who still carry a licence — i.e. a leaver still costing money.
// Graph filters accountEnabled server-side; assignedLicenses is filtered here because Graph cannot
// filter on its length.
export async function listDisabledLicensedUsers(
  token: string,
  fetcher: GraphFetch = fetch,
  opts: GraphRetryOpts = {}
): Promise<{ ok: boolean; users: DisabledLicensedUser[]; error?: string }> {
  const users: DisabledLicensedUser[] = [];
  let url: string | null =
    `${GRAPH}/users?$filter=accountEnabled eq false&$select=id,displayName,userPrincipalName,assignedLicenses&$top=999`;
  while (url) {
    const page: Awaited<ReturnType<typeof graphGet>> = await graphGet<{
      value?: { id?: string; displayName?: string; userPrincipalName?: string; assignedLicenses?: { skuId?: string }[] }[];
      "@odata.nextLink"?: string;
    }>(token, url, fetcher, opts);
    if (!page.ok) return { ok: false, users, error: page.error };
    const body = page.body as {
      value?: { id?: string; displayName?: string; userPrincipalName?: string; assignedLicenses?: { skuId?: string }[] }[];
      "@odata.nextLink"?: string;
    };
    for (const u of body.value ?? []) {
      const skuIds = (u.assignedLicenses ?? []).map((l) => String(l.skuId)).filter(Boolean);
      if (!skuIds.length) continue; // disabled but unlicensed = already clean
      users.push({ id: String(u.id), displayName: String(u.displayName ?? ""), userPrincipalName: String(u.userPrincipalName ?? ""), skuIds });
    }
    url = body["@odata.nextLink"] ?? null;
  }
  return { ok: true, users };
}

// skuId -> skuPartNumber ("SPE_E5"), so the report names licences instead of printing GUIDs.
export async function readSkuNames(token: string, fetcher: GraphFetch = fetch, opts: GraphRetryOpts = {}): Promise<Map<string, string>> {
  const res = await graphGet<{ value?: { skuId?: string; skuPartNumber?: string }[] }>(token, `/subscribedSkus?$select=skuId,skuPartNumber`, fetcher, opts);
  if (!res.ok) return new Map();
  return new Map((res.body.value ?? []).map((s) => [String(s.skuId), String(s.skuPartNumber)]));
}

// Is this user's mailbox a SHARED mailbox? `userPurpose` is the only app-only Graph signal for it, and
// it needs MailboxSettings.Read — which most tenants have not granted, hence the optional cap.
//   "shared" -> converted   |   "user" -> NOT converted   |   null -> cannot tell (no permission, or
//   the user has no mailbox at all)
export async function readMailboxPurpose(
  token: string,
  userId: string,
  fetcher: GraphFetch = fetch,
  opts: GraphRetryOpts = {}
): Promise<{ purpose: string | null; denied: boolean }> {
  const res = await graphGet<{ userPurpose?: string }>(token, `/users/${encodeURIComponent(userId)}/mailboxSettings?$select=userPurpose`, fetcher, opts);
  if (res.ok) return { purpose: res.body.userPurpose ?? null, denied: false };
  // 403 = the permission is missing (a fleet-wide fact); 404 = this user simply has no mailbox.
  return { purpose: null, denied: res.status === 403 };
}
