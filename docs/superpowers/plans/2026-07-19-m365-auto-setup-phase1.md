# Automated M365 setup — Phase 1 (Graph provisioning core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic, browser-free `provisionM365App()` that, given a GA-privileged delegated Graph token + tenant, finds-or-creates the `iam-engine` Entra app registration, attaches a client secret + self-signed cert, sets and **admin-consents** the required + all optional Graph app roles, verifies, and returns the credential shape Phase 3 will vault.

**Architecture:** New `web/lib/secrets/provision-m365-app.ts`, pure Microsoft Graph REST over an injected `fetch` (mirrors `graph-app-roles.ts`). Role GUIDs are resolved from the tenant's **live** Graph service-principal `appRoles` (not a static map). Cert generation reuses the existing `web/lib/m365/exo-cert.ts` (`generateExoCert`, node-forge). Unit-tested with a routing `fetch` mock; live-tenant validation is a documented manual step (deferred to the operator).

**Tech Stack:** Next.js/TypeScript (`web/`), `node:test` via `tsx --test`, `node-forge` (already a dependency).

## Global Constraints
- **Commit + changelog per feature** (one changelog entry when the feature is user-meaningful; Phase 1 ships one entry at the end — this is internal groundwork, not yet wired to any UI). Changelog `time` = `TZ=America/New_York date +%H:%M` floored to a 15-min boundary ≤ now (never future); one file per entry in `web/lib/changelog/entries/` + registered id-sorted in `_registry.ts` ([[changelog-times-eastern]], [[changelog-after-every-commit]]).
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **tsc baseline:** `npx tsc --noEmit` in `web/` is NOT clean on main — there are 3 pre-existing `warningsDismissed` errors in `web/app/cases/_components/run-report-view.tsx`. Gate = "no NEW errors beyond those 3".
- **Tests:** `cd web && npx tsx --test lib/secrets/provision-m365-app.test.ts`; pass `{ backoff: () => 0 }` as `GraphRetryOpts` to exercise retry paths without wall-clock cost.
- **No new dependency** — reuse `generateExoCert` from `web/lib/m365/exo-cert.ts` and `node-forge` (already present). Do NOT add `@peculiar/*`.
- **Reconcile rule:** on a re-run where the app exists, add missing role grants but do NOT mint a new secret/cert when a valid one exists.
- **Live validation is out of scope for the build** — the provisioning cannot be run against a real tenant here (no GA token). Ship unit-tested; the live run is a documented operator step in the spec.

---

## File Structure
- **Create** `web/lib/secrets/provision-m365-app.ts` — the whole Phase 1 module (`provisionM365App` + `resolveGraphAppRoleIds` + types).
- **Create** `web/lib/secrets/provision-m365-app.test.ts` — unit tests.
- **Modify** `web/lib/secrets/graph-app-roles.ts` — add a `graphSend` POST/PATCH wrapper (export it) reusing the existing retry machinery.
- **Create** `web/lib/changelog/entries/m365-app-auto-provision-core.ts` (+ register).

---

## Task 1: `graphSend` — a POST/PATCH sibling of `graphGet`

**Files:** Modify `web/lib/secrets/graph-app-roles.ts`. Test: `web/lib/secrets/graph-app-roles.test.ts` (append).

**Interfaces:**
- Produces: `export async function graphSend<T>(token: string, method: "POST"|"PATCH", url: string, body: unknown, fetcher?: GraphFetch, opts?: GraphRetryOpts): Promise<{ ok: true; status: number; body: T | null } | { ok: false; status: number; error: string }>` — reuses `RETRYABLE`/`DEFAULT_BACKOFF`/`sleep`. Returns `body: null` for a 204/empty response.

- [ ] **Step 1: Write the failing test** (append to `graph-app-roles.test.ts`):
```ts
import { graphSend } from "./graph-app-roles";

test("graphSend POSTs JSON with the right method/headers/body and returns the parsed body", async () => {
  let seen: { url: string; method?: string; ct?: string; body?: string } | null = null;
  const f = (async (url: string, init?: { method?: string; headers?: Record<string,string>; body?: string }) => {
    seen = { url, method: init?.method, ct: init?.headers?.["Content-Type"], body: init?.body };
    return new Response(JSON.stringify({ id: "new-app" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const r = await graphSend<{ id: string }>("tok", "POST", "/applications", { displayName: "iam-engine" }, f, { backoff: () => 0 });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.body?.id, "new-app");
  assert.equal(seen!.method, "POST");
  assert.equal(seen!.ct, "application/json");
  assert.equal(seen!.url, "https://graph.microsoft.com/v1.0/applications");
  assert.deepEqual(JSON.parse(seen!.body!), { displayName: "iam-engine" });
});

test("graphSend returns ok with null body on a 204", async () => {
  const f = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const r = await graphSend("tok", "POST", "/x", {}, f, { backoff: () => 0 });
  assert.equal(r.ok && r.body === null, true);
});

test("graphSend surfaces a non-retryable error with status + text", async () => {
  const f = (async () => new Response("Insufficient privileges", { status: 403 })) as unknown as typeof fetch;
  const r = await graphSend("tok", "POST", "/x", {}, f, { backoff: () => 0 });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 403);
  assert.match((!r.ok && r.error) || "", /Insufficient/);
});
```

- [ ] **Step 2: Run — expect FAIL** (`cd web && npx tsx --test lib/secrets/graph-app-roles.test.ts`) → `graphSend` not exported.

- [ ] **Step 3: Implement `graphSend`** in `graph-app-roles.ts` (add after `graphGet`; it reuses the module-private `GRAPH`, `RETRYABLE`, `DEFAULT_BACKOFF`, `sleep`):
```ts
// A Graph POST/PATCH with the same backoff/timeout as graphGet. Returns the parsed body (or null
// on 204/empty). Adds Content-Type: application/json.
export async function graphSend<T>(
  token: string,
  method: "POST" | "PATCH",
  url: string,
  body: unknown,
  fetcher: GraphFetch = fetch,
  opts: GraphRetryOpts = {}
): Promise<{ ok: true; status: number; body: T | null } | { ok: false; status: number; error: string }> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let last = { ok: false as const, status: 0, error: "no attempt made" };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoff(attempt));
    try {
      const res = await fetcher(url.startsWith("http") ? url : `${GRAPH}${url}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: true, status: res.status, body: text ? (JSON.parse(text) as T) : null };
      }
      const text = await res.text().catch(() => "");
      last = { ok: false, status: res.status, error: text.slice(0, 300) || `HTTP ${res.status}` };
      if (!RETRYABLE.test(String(res.status))) return last;
    } catch (e) {
      last = { ok: false, status: 0, error: (e as Error).message };
    }
  }
  return last;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: tsc** (`npx tsc --noEmit` → only the 3 known errors) and **commit** `feat(secrets): graphSend — Graph POST/PATCH wrapper reusing graphGet's retry` + trailer.

---

## Task 2: `resolveGraphAppRoleIds` — resolve role name→GUID from the live Graph SP

**Files:** Create `web/lib/secrets/provision-m365-app.ts`. Test: `web/lib/secrets/provision-m365-app.test.ts`.

**Interfaces:**
- Consumes: `graphGet`, `GraphFetch`, `GraphRetryOpts` from `./graph-app-roles`; `GRAPH_RESOURCE_APP_ID`, `GRAPH_REQUIRED_CAPS`, `GRAPH_OPTIONAL_CAPS`, `suggestedRole` from `./graph-caps`.
- Produces: `export type GraphSpRoles = { graphSpId: string; roleIdByName: Map<string, string> }` (name lowercased → GUID); `export async function resolveGraphAppRoleIds(token, fetcher?, opts?): Promise<{ ok: true } & GraphSpRoles | { ok: false; error: string }>`; `export function chosenRoleNames(caps: "required" | "required+optional"): string[]` (dedup of `suggestedRole` over the chosen caps).

- [ ] **Step 1: Write the failing tests:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGraphAppRoleIds, chosenRoleNames } from "./provision-m365-app";

const FAST = { backoff: () => 0 };
const OK = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

test("chosenRoleNames: required+optional is the deduped suggested roles", () => {
  const names = chosenRoleNames("required+optional");
  assert.ok(names.includes("User.ReadWrite.All"));   // required cap #1 suggested
  assert.ok(names.includes("Mail.Send"));            // an optional cap suggested
  assert.equal(new Set(names).size, names.length);   // no dupes
});

test("resolveGraphAppRoleIds: reads the Graph SP appRoles into a name->id map", async () => {
  const f = (async (url: string) => {
    if (url.includes("/servicePrincipals") && url.includes("appId+eq") === false && url.includes("$filter")) {
      return OK({ value: [{ id: "graph-sp", appRoles: [
        { id: "guid-user-rw", value: "User.ReadWrite.All" },
        { id: "guid-mail", value: "Mail.Send" },
      ] }] });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  const r = await resolveGraphAppRoleIds("tok", f, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.graphSpId, "graph-sp");
  assert.equal(r.ok && r.roleIdByName.get("user.readwrite.all"), "guid-user-rw");
});
```

- [ ] **Step 2: Run — expect FAIL** (module/exports missing).

- [ ] **Step 3: Implement** the top of `provision-m365-app.ts`:
```ts
import { graphGet, graphSend, type GraphFetch, type GraphRetryOpts, readGrantedAppRoles } from "./graph-app-roles";
import { GRAPH_RESOURCE_APP_ID, GRAPH_REQUIRED_CAPS, GRAPH_OPTIONAL_CAPS, suggestedRole, graphCapGaps } from "./graph-caps";
import { generateExoCert } from "../m365/exo-cert";

export type GraphSpRoles = { graphSpId: string; roleIdByName: Map<string, string> };

// The Graph app-role NAMES to grant, deduped, using each cap's least-privilege suggested role.
export function chosenRoleNames(caps: "required" | "required+optional"): string[] {
  const list = caps === "required+optional" ? [...GRAPH_REQUIRED_CAPS, ...GRAPH_OPTIONAL_CAPS] : [...GRAPH_REQUIRED_CAPS];
  return [...new Set(list.map((c) => suggestedRole(c)))];
}

// Resolve every Graph app-role NAME to its application-appRole GUID by reading the tenant's Microsoft
// Graph service principal's appRoles — robust vs. a static GUID map (GRAPH_APP_ROLE_IDS omits the
// required-cap roles), and self-consistent with readGrantedAppRoles which maps id->name in reverse.
export async function resolveGraphAppRoleIds(
  token: string, fetcher: GraphFetch = fetch, opts: GraphRetryOpts = {}
): Promise<({ ok: true } & GraphSpRoles) | { ok: false; error: string }> {
  const r = await graphGet<{ value?: { id?: string; appRoles?: { id?: string; value?: string }[] }[] }>(
    token, `/servicePrincipals?$filter=appId eq '${GRAPH_RESOURCE_APP_ID}'&$select=id,appRoles`, fetcher, opts
  );
  if (!r.ok) return { ok: false, error: r.error };
  const sp = r.body.value?.[0];
  if (!sp?.id) return { ok: false, error: "Microsoft Graph service principal not found in tenant" };
  const roleIdByName = new Map<string, string>();
  for (const role of sp.appRoles ?? []) {
    if (role.id && role.value) roleIdByName.set(String(role.value).toLowerCase(), String(role.id));
  }
  return { ok: true, graphSpId: sp.id, roleIdByName };
}
```
(Adjust the test's `$filter` URL substring matching to the real emitted URL — the filter is `appId eq '<GRAPH_RESOURCE_APP_ID>'`; assert on `/servicePrincipals` + `appId+eq` url-encoded, or match `decodeURIComponent(url).includes("appId eq")`.)

- [ ] **Step 4: Run — expect PASS.** tsc clean. **Commit** `feat(secrets): resolve Graph app-role GUIDs from the live Graph service principal` + trailer.

---

## Task 3: `provisionM365App` — find/create app + requiredResourceAccess + SP + admin-consent

**Files:** Modify `web/lib/secrets/provision-m365-app.ts`. Test: same test file (append).

**Interfaces:**
- Produces: `export type ProvisionInput = { graphToken: string; tenantId: string; caps?: "required" | "required+optional"; issueCreds?: boolean }`; `export type ProvisionResult = { appId: string; objectId: string; spId: string; tenantId: string; clientSecret?: string; certBase64?: string; certPassword?: string; created: boolean; granted: string[]; gaps: string[]; actions: string[] }`; `export async function provisionM365App(input: ProvisionInput, fetcher?: GraphFetch, opts?: GraphRetryOpts): Promise<{ ok: true; result: ProvisionResult } | { ok: false; error: string; actions: string[] }>`. This task implements the app + SP + consent legs (creds/verify in Task 4).

- [ ] **Step 1: Write the failing test** — a routing `fetch` mock covering: resolve Graph SP; find app (empty → create); find SP (empty → create); appRoleAssignedTo (record each). Assert the app is created with `tags:["ctg:iam-engine"]` and a `requiredResourceAccess` entry per chosen role, and that an `appRoleAssignedTo` POST fires for each chosen role.
```ts
import { provisionM365App } from "./provision-m365-app";
// build a routing mock: GET /servicePrincipals?$filter=appId eq '00000003-...' -> {value:[{id:'graph-sp',appRoles:[...all chosen roles...]}]}
// GET /applications?$filter=... -> {value:[]}; POST /applications -> {id:'obj-1',appId:'app-1'}
// GET /servicePrincipals?$filter=appId eq 'app-1' -> {value:[]}; POST /servicePrincipals -> {id:'app-sp'}
// POST /servicePrincipals/graph-sp/appRoleAssignedTo -> capture principalId/resourceId/appRoleId, return {id:'a'}
// (creds/verify endpoints stub minimally; assert created===true, requiredResourceAccess length, and one assignment per role)
```
(Write the full routing mock in the test — model it on `graph-app-roles.test.ts`'s `tenantFetch`, extended to POSTs that read `init.body`.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the app/SP/consent legs (append to `provision-m365-app.ts`). Show the full function skeleton with these legs (creds+verify filled in Task 4):
```ts
const APP_DISPLAY_NAME = "iam-engine";
const APP_TAG = "ctg:iam-engine";

export async function provisionM365App(
  input: ProvisionInput, fetcher: GraphFetch = fetch, opts: GraphRetryOpts = {}
): Promise<{ ok: true; result: ProvisionResult } | { ok: false; error: string; actions: string[] }> {
  const { graphToken: token, tenantId } = input;
  const caps = input.caps ?? "required+optional";
  const actions: string[] = [];

  const roles = await resolveGraphAppRoleIds(token, fetcher, opts);
  if (!roles.ok) return { ok: false, error: `resolve Graph app roles: ${roles.error}`, actions };
  const wantRoleNames = chosenRoleNames(caps);
  const wantRoleIds: { name: string; id: string }[] = [];
  for (const name of wantRoleNames) {
    const id = roles.roleIdByName.get(name.toLowerCase());
    if (!id) return { ok: false, error: `Graph app role not found in tenant: ${name}`, actions };
    wantRoleIds.push({ name, id });
  }

  // find-or-create the app (idempotent by displayName + tag)
  const find = await graphGet<{ value?: { id?: string; appId?: string; tags?: string[] }[] }>(
    token, `/applications?$filter=displayName eq '${APP_DISPLAY_NAME}'&$select=id,appId,tags`, fetcher, opts);
  if (!find.ok) return { ok: false, error: `find app: ${find.error}`, actions };
  let app = (find.body.value ?? []).find((a) => (a.tags ?? []).includes(APP_TAG)) ?? (find.body.value ?? [])[0];
  let created = false;
  const requiredResourceAccess = [{
    resourceAppId: GRAPH_RESOURCE_APP_ID,
    resourceAccess: wantRoleIds.map((r) => ({ id: r.id, type: "Role" })),
  }];
  if (!app?.id || !app.appId) {
    const c = await graphSend<{ id: string; appId: string }>(token, "POST", "/applications", {
      displayName: APP_DISPLAY_NAME, signInAudience: "AzureADMyOrg", tags: [APP_TAG], requiredResourceAccess,
    }, fetcher, opts);
    if (!c.ok || !c.body) return { ok: false, error: `create app: ${!c.ok ? c.error : "no body"}`, actions };
    app = c.body; created = true; actions.push(`created app registration ${app.appId}`);
  } else {
    const p = await graphSend(token, "PATCH", `/applications/${app.id}`, { requiredResourceAccess }, fetcher, opts);
    if (!p.ok) return { ok: false, error: `update app permissions: ${p.error}`, actions };
    actions.push(`found existing app ${app.appId} — reconciled requiredResourceAccess`);
  }
  const objectId = app.id!, appId = app.appId!;

  // find-or-create the app's service principal
  const spFind = await graphGet<{ value?: { id?: string }[] }>(
    token, `/servicePrincipals?$filter=appId eq '${appId}'&$select=id`, fetcher, opts);
  if (!spFind.ok) return { ok: false, error: `find SP: ${spFind.error}`, actions };
  let spId = spFind.body.value?.[0]?.id;
  if (!spId) {
    const spc = await graphSend<{ id: string }>(token, "POST", "/servicePrincipals", { appId }, fetcher, opts);
    if (!spc.ok || !spc.body) return { ok: false, error: `create SP: ${!spc.ok ? spc.error : "no body"}`, actions };
    spId = spc.body.id; actions.push("created service principal");
  }

  // admin-consent: assign each chosen role, skipping ones already granted
  const already = await readGrantedAppRoles(token, appId, fetcher, opts);
  const haveIds = new Set(already.ok ? [] as string[] : []); // names only; re-resolve to ids below
  // (readGrantedAppRoles returns NAMES; convert to ids to compare)
  const haveNameSet = new Set((already.roles ?? []).map((n) => n.toLowerCase()));
  for (const r of wantRoleIds) {
    if (haveNameSet.has(r.name.toLowerCase())) { actions.push(`role already granted: ${r.name}`); continue; }
    const a = await graphSend(token, "POST", `/servicePrincipals/${roles.graphSpId}/appRoleAssignedTo`, {
      principalId: spId, resourceId: roles.graphSpId, appRoleId: r.id,
    }, fetcher, opts);
    if (!a.ok) { actions.push(`WARN could not grant ${r.name}: ${a.error}`); continue; }
    actions.push(`granted (admin-consented) ${r.name}`);
  }

  // (Task 4 fills in credentials + verify + assembles ProvisionResult here)
  return { ok: false, error: "credentials/verify not implemented (Task 4)", actions };
}
```
(Note: leave the explicit `haveIds` line out if unused; the name-set comparison is the working path. Keep the code that compiles + passes the app/SP/consent tests; Task 4 replaces the trailing `return`.)

- [ ] **Step 4: Run — the app/SP/consent assertions PASS** (the function still returns `ok:false` pending Task 4, so the test asserts on the captured requests + `actions`, not on a success result yet). tsc clean.
- [ ] **Step 5: Commit** `feat(secrets): provisionM365App — find/create app + requiredResourceAccess + admin-consent` + trailer.

---

## Task 4: Credentials (reconcile rule) + verify + assemble ProvisionResult

**Files:** Modify `web/lib/secrets/provision-m365-app.ts`. Test: append.

**Interfaces:** Consumes `generateExoCert` (from `../m365/exo-cert` → `{ cerPem, pfxBase64, password, thumbprintSha1 }`). Completes `provisionM365App` to return `{ ok: true; result: ProvisionResult }`.

- [ ] **Step 1: Write the failing tests** — extend the routing mock with: `GET /applications/{objectId}?$select=passwordCredentials,keyCredentials` (empty → issue), `POST /applications/{objectId}/addPassword` → `{ secretText: "the-secret" }`, `PATCH /applications/{objectId}` (keyCredentials upload) → 204, and the final `readGrantedAppRoles` returning all chosen roles. Assert:
  - fresh app → `result.clientSecret === "the-secret"`, `result.certBase64` is set, `result.created === true`, `result.gaps` empty.
  - **reconcile rule:** when `GET .../$select=passwordCredentials,keyCredentials` returns a NON-expired secret, `addPassword` is NOT called and `result.clientSecret` is undefined.
```ts
// (write both tests with the routing mock; use generateExoCert's real output — it's pure and fast enough,
//  or stub the cert step by asserting a keyCredentials PATCH fired.)
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — replace Task 3's trailing `return` with credentials + verify + assembly:
```ts
  // credentials — reconcile rule: only issue when none valid exists
  let clientSecret: string | undefined, certBase64: string | undefined, certPassword: string | undefined;
  const issue = input.issueCreds ?? true;
  if (issue) {
    const creds = await graphGet<{ passwordCredentials?: { endDateTime?: string }[]; keyCredentials?: { endDateTime?: string }[] }>(
      token, `/applications/${objectId}?$select=passwordCredentials,keyCredentials`, fetcher, opts);
    const now = Date.now();
    const hasValid = (list?: { endDateTime?: string }[]) =>
      (list ?? []).some((c) => !c.endDateTime || Date.parse(c.endDateTime) > now);
    const secretValid = creds.ok && hasValid(creds.body.passwordCredentials);
    const certValid = creds.ok && hasValid(creds.body.keyCredentials);
    if (!secretValid) {
      const ap = await graphSend<{ secretText?: string }>(token, "POST", `/applications/${objectId}/addPassword`,
        { passwordCredential: { displayName: "ctg-secret" } }, fetcher, opts);
      if (!ap.ok || !ap.body?.secretText) return { ok: false, error: `add secret: ${!ap.ok ? ap.error : "no secretText"}`, actions };
      clientSecret = ap.body.secretText; actions.push("issued a new client secret");
    } else { actions.push("kept existing client secret (valid)"); }
    if (!certValid) {
      const cert = await generateExoCert();  // { cerPem, pfxBase64, password, thumbprintSha1 }
      const der = cert.cerPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
      const patch = await graphSend(token, "PATCH", `/applications/${objectId}`, {
        keyCredentials: [{ type: "AsymmetricX509Cert", usage: "Verify", key: der, displayName: "ctg-cert" }],
      }, fetcher, opts);
      if (!patch.ok) return { ok: false, error: `upload cert: ${patch.error}`, actions };
      certBase64 = cert.pfxBase64; certPassword = cert.password; actions.push("issued + uploaded a new certificate");
    } else { actions.push("kept existing certificate (valid)"); }
  }

  // verify granted vs required
  const verify = await readGrantedAppRoles(token, appId, fetcher, opts);
  const granted = verify.ok ? verify.roles : [];
  const gaps = graphCapGaps(granted).map((c) => suggestedRole(c));

  return { ok: true, result: { appId, objectId, spId: spId!, tenantId, clientSecret, certBase64, certPassword, created, granted, gaps, actions } };
```

- [ ] **Step 4: Run — expect PASS** (both fresh-issue and reconcile-keep tests). Full file: `npx tsx --test lib/secrets/provision-m365-app.test.ts`. tsc clean.
- [ ] **Step 5: Commit** `feat(secrets): provisionM365App issues secret+cert (reconcile rule) + verifies granted roles` + trailer.

---

## Task 5: Changelog + full verification

- [ ] **Step 1:** Create `web/lib/changelog/entries/m365-app-auto-provision-core.ts` (format per a sibling; read one first). `id: "m365-app-auto-provision-core"`, `date: "2026-07-19"`, `time` = `TZ=America/New_York date +%H:%M` floored ≤ now. Title "Groundwork: automated Entra app-registration provisioning (Graph core)". Items (1-2): internal `provisionM365App` — given a Global-Admin Graph token it finds/creates the iam-engine app, attaches a secret + cert, and admin-consents the required + all optional Graph app roles; not yet wired to the browser-auth or UI (later phases). Register id-sorted in `_registry.ts`.
- [ ] **Step 2:** `cd web && npx tsx --test "lib/**/*.test.ts"` — full suite green (incl. the new provision + graphSend tests + changelog registry). `npx tsc --noEmit` → only the 3 known errors.
- [ ] **Step 3:** Commit `docs(changelog): m365 app auto-provision core` + trailer.

## Verification (Phase 1 done when)
- Unit tests green with the mocked routing fetch: fresh-create issues secret+cert + consents all chosen roles + zero required gaps; re-run reconciles (adds missing grants, keeps valid creds); role GUIDs resolve from the live Graph SP; `graphSend` covers POST/PATCH/204/error.
- tsc adds no new errors.
- **Live (operator, out of build scope):** with a hand-obtained GA delegated Graph token (scopes `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `Directory.ReadWrite.All`) run `provisionM365App` against one real tenant; confirm the `iam-engine` app is created, all required+optional Graph roles show consented in Entra, and the returned `{appId, secret, cert, tenant}` passes `probeEntraClientCredentials` (after consent propagation).

## Self-review notes (coverage vs spec)
Find-or-create idempotent by tag → Task 3. requiredResourceAccess from required+all-optional → Tasks 2/3. Admin-consent (appRoleAssignedTo), skip existing → Task 3. Secret+cert, reconcile rule → Task 4. Verify via readGrantedAppRoles + graphCapGaps → Task 4. Role-GUID incompleteness solved by live-SP resolution → Task 2. No new dependency (reuse generateExoCert) → Task 4. ProvisionResult shape matches the spec (+ maps to appId/secret/tenant for Phase 3). Live validation explicitly deferred.
