# Set up Google Workspace automatically — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click provisioning of a Google Workspace service-account credential for a client: operator enters the super-admin Delinea secret ID → app creates GCP project + service account + key (REST), a runner browser job grants domain-wide delegation, the key is vaulted in Delinea on the "Automation - API" template, wired into the client's `google-admin` slot with an "(auto)" label, and the `google-workspace` conn test proves it.

**Architecture:** Parallel clone of the M365 auto-setup pipeline (`setup-m365-client.ts` family) — new tables, new core, new routes, new modal; **zero changes to any m365-named file**. Two narrow runner browser jobs (Google sign-in + OAuth consent capture; DWD grant page); everything between is app-side REST against Google Cloud APIs using a PKCE-bound token from gcloud's public OAuth client.

**Tech Stack:** Next.js App Router + Prisma (web), vitest (colocated `*.test.ts`), PowerShell 7 + Playwright `.mjs` flows (runner), Pester for runner tests (`~/.local/pwsh/pwsh`).

**Spec:** `docs/superpowers/specs/2026-07-20-google-workspace-auto-setup-design.md` — binding. Read it before starting any task.

## Global Constraints

- **Never modify** the M365 setup flow: no edits to `setup-m365-client.ts`, `provision-m365-app.ts`, `write-m365-app.ts`, `m365-setup-run.ts`, `m365-setup-button.tsx`, the `M365SetupRun*` models, or the m365 routes. Read them as references only.
- Delinea secret name: exactly `Google API - IAM Engine`. Template default name: `Automation - API` (env-overridable via the existing `DELINEA_TEMPLATE_MAP` / `DELINEA_TEMPLATE_<KEY>` mechanism). Field mapping: `ClientID` = Google customer ID, `ClientSecret` = **base64 of the full service-account JSON key** (single line), `accountid` = service-account email, `apiURL` = impersonate (super-admin) email.
- Client secret-slot name: `google-admin` (existing profile convention). Seed secret override name: `google-super-admin`. Wire label: `Google service account (auto)`.
- DWD scopes, verbatim, in this order: `https://www.googleapis.com/auth/admin.directory.user`, `https://www.googleapis.com/auth/admin.directory.group`, `https://www.googleapis.com/auth/admin.directory.orgunit`, `https://www.googleapis.com/auth/admin.directory.user.security`.
- OAuth: gcloud CLI public installed-app client — `CLOUDSDK_CLIENT_ID = 32555940559.apps.googleusercontent.com`, `CLOUDSDK_CLIENT_NOTSOSECRET = ZmssLNjJy2998hD4CTg2ejr2` (implementer of Task 2 verifies both against the published google-cloud-sdk `lib/googlecloudsdk/core/config.py` before use). Scope: `https://www.googleapis.com/auth/cloud-platform`. PKCE S256 mandatory; the verifier never leaves the app process.
- GCP naming: projectId `ctg-iam-{slug}` truncated to 30 chars, trimmed of trailing `-`; service account id `iam-engine`, displayName `iam-engine (Coretelligent IAM)`.
- Secret material (SA private key, seed password, access tokens) must never appear in: Job rows, AuditLog, run `log[]`, console logs, or thrown error messages.
- Runner: bump `runner/VERSION` to `1.79.0` (minor) in the task that first touches runner code that ships. New browser jobs are gated on the `browser` runner capability like `entra-devicecode`.
- Migrations: create with `npx prisma migrate dev --create-only` then apply with `npx prisma migrate deploy` + `npx prisma generate`. **Never** plain `prisma migrate dev` (shared dev DB — reset incident 2026-07-13).
- Web tests: `cd web && npx vitest run <file>`; full suite `npx vitest run`. Pester: `~/.local/pwsh/pwsh -Command "Invoke-Pester runner/tests/<file> -Output Detailed"`.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Ship a changelog entry (one-file-per-entry under `web/lib/changelog/entries/`, registered in `_registry.ts`, `time` = Eastern 15-min boundary) — Task 12.

## File Structure

```
web/prisma/schema.prisma                     (modify: +GoogleSetupRun, +GoogleSetupRunClient)
web/prisma/migrations/<ts>_google_setup_runs/
web/lib/secrets/google-oauth.ts              (new: PKCE, auth URL, code→token exchange)
web/lib/secrets/provision-google-workspace.ts(new: project/APIs/SA/key REST, CredState)
web/lib/secrets/google-verify.ts             (new: SA JWT sign + directory probe + retry)
web/lib/secrets/write-google-workspace.ts    (new: Delinea vault + wire)
web/lib/secrets/dispatch-google-browser-job.ts(new: both browser-job dispatches)
web/lib/secrets/setup-google-client.ts       (new: DI core, stage machine)
web/lib/secrets/setup-google-deps.ts         (new: prod deps bundle)
web/lib/secrets/google-setup-run.ts          (new: run lifecycle)
web/lib/secrets/field-requirements.ts        (modify: +google-admin)
web/lib/secrets/delinea-templates.ts         (modify: +google-admin default template name)
web/lib/secrets/value-probe.ts               (modify: +google-admin probe)
web/app/api/clients/[slug]/google-setup/route.ts (new: POST/GET)
web/app/clients/_components/google-setup-button.tsx (new: modal)
web/app/clients/_components/client-actions-menu.tsx (modify: menu item)
runner/modules/Coretelligent.GoogleWorkspace/…psm1 (modify: Use-CtgGoogleSecret shapes)
runner/Start-IamRunner.ps1                   (modify: 2 $DISPATCH entries)
runner/browser/flows/google-oauth-signin.mjs (new)
runner/browser/flows/google-dwd-grant.mjs    (new)
runner/VERSION                               (modify: 1.79.0)
docs/modules/google-workspace.md             (modify: credential shape docs)
web/lib/changelog/entries/…                  (new entry, Task 12)
```

Each `web/lib/secrets/*.ts` file gets a colocated `*.test.ts` (existing convention).

---

### Task 1: Prisma models + migration

**Files:**
- Modify: `web/prisma/schema.prisma` (append after `M365SetupRunClient`, ~line 913)
- Create: migration via `--create-only`

**Interfaces:**
- Produces: `GoogleSetupRun`, `GoogleSetupRunClient` Prisma models used by Tasks 7–9.

- [ ] **Step 1: Add models** — mirror the `M365SetupRun` pair (schema.prisma:871–913) with these deltas: drop `dryRun`, `appId`, `userCode`, `verificationUri`, `wroteCreds`; add Google fields:

```prisma
model GoogleSetupRun {
  id         String                 @id @default(cuid())
  scope      String // "client:<clientId>" (no fleet mode)
  status     String                 @default("running") // running | done | failed
  startedAt  DateTime               @default(now())
  finishedAt DateTime?
  startedBy  String?
  total      Int                    @default(0)
  completed  Int                    @default(0)
  succeeded  Int                    @default(0)
  skipped    Int                    @default(0)
  failed     Int                    @default(0)
  error      String?
  clients    GoogleSetupRunClient[]

  @@index([scope, startedAt])
}

model GoogleSetupRunClient {
  id         String         @id @default(cuid())
  run        GoogleSetupRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  runId      String
  clientId   String
  slug       String
  name       String
  status     String         @default("pending") // pending | running | done | needs_action | skipped | failed
  stage      String? // GoogleSetupResult.stage
  saEmail    String?
  saClientId String? // numeric uniqueId — the DWD grant target
  verified   Boolean?
  wroteCreds Boolean?
  skipReason String?
  error      String?
  warnings   String[]
  userAction Json? // manual-DWD fallback card: { kind:"dwd", clientId, scopes } — non-secret only
  log        String[]
  updatedAt  DateTime       @updatedAt

  @@index([runId])
}
```

- [ ] **Step 2: Create + apply migration**

Run (from `web/`): `npx prisma migrate dev --create-only --name google_setup_runs`, then `npx prisma migrate deploy`, then `npx prisma generate`.
Expected: migration applied, client regenerated, no drift errors.

- [ ] **Step 3: Sanity-check** — `npx tsc --noEmit` still passes (or same pre-existing errors as `git stash`-free baseline); commit.

```bash
git add web/prisma && git commit -m "feat: GoogleSetupRun tables for Google Workspace auto-setup"
```

---

### Task 2: `google-oauth.ts` — PKCE + auth URL + code exchange

**Files:**
- Create: `web/lib/secrets/google-oauth.ts`, `web/lib/secrets/google-oauth.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 6, 7):

```ts
export const GCLOUD_CLIENT_ID = "32555940559.apps.googleusercontent.com";
export const GCLOUD_CLIENT_SECRET = "ZmssLNjJy2998hD4CTg2ejr2"; // public installed-app "notsosecret"
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const OAUTH_REDIRECT_URI = "http://127.0.0.1:8765/oauth2callback"; // loopback; never actually served

export type PkcePair = { verifier: string; challenge: string };
export function makePkcePair(): PkcePair; // node:crypto randomBytes(32) base64url; challenge = base64url(sha256(verifier))
export function buildAuthUrl(challenge: string, loginHint: string): string; // accounts.google.com/o/oauth2/v2/auth with access_type=online, prompt=consent, code_challenge_method=S256
export async function exchangeCodeForToken(
  code: string, verifier: string, fetcher?: typeof fetch
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }>; // POST https://oauth2.googleapis.com/token, x-www-form-urlencoded
```

- [ ] **Step 1:** Verify the two gcloud constants against google-cloud-sdk's published `lib/googlecloudsdk/core/config.py` (WebSearch/WebFetch). If they differ, use the published values and note it in the commit body.
- [ ] **Step 2:** Write failing tests: `makePkcePair` returns base64url (no `+/=`), 43-char verifier, challenge = RFC 7636 S256 of verifier (compute expected with node:crypto in the test); `buildAuthUrl` contains client_id, redirect_uri (URL-encoded), scope, `code_challenge_method=S256`, `login_hint`; `exchangeCodeForToken` posts grant_type=authorization_code with code_verifier and parses `access_token`, and returns `{ok:false}` (never throws) on non-200 / missing token. Mock `fetcher`.
- [ ] **Step 3:** Run `npx vitest run lib/secrets/google-oauth.test.ts` — expect FAIL (module missing).
- [ ] **Step 4:** Implement; error strings must not include response bodies verbatim beyond Google's `error` field (no token echo).
- [ ] **Step 5:** Tests pass; commit `feat: PKCE + gcloud public-client OAuth exchange for Google setup`.

---

### Task 3: `provision-google-workspace.ts` — project / APIs / SA / key

**Files:**
- Create: `web/lib/secrets/provision-google-workspace.ts`, `.test.ts`

**Interfaces:**
- Consumes: access token string (Task 2's exchange result).
- Produces (consumed by Task 7):

```ts
export type CredState = "issued" | "kept-valid";
export type GoogleProvision = {
  projectId: string;
  saEmail: string;        // iam-engine@{projectId}.iam.gserviceaccount.com
  saClientId: string;     // numeric uniqueId
  credState: CredState;
  keyBase64?: string;     // base64 of full JSON key — present iff credState === "issued"
  issuedKeyName?: string; // full resource name of the key we created (for rotate-cleanup by Task 7)
  actions: string[];      // human trail, NO secret material
};
export function projectIdForSlug(slug: string): string; // "ctg-iam-"+slug, lowercase, [a-z0-9-], ≤30 chars, no trailing "-"
export async function provisionGoogleWorkspace(input: {
  accessToken: string; clientSlug: string;
  needKey: boolean;     // true when nothing valid vaulted or forceRotate
  fetcher?: typeof fetch;
}): Promise<{ ok: true; value: GoogleProvision } | { ok: false; error: string; actions: string[] }>;
export async function deleteServiceAccountKey(accessToken: string, keyName: string, fetcher?: typeof fetch): Promise<boolean>;
```

**Endpoints (v3 Resource Manager, v1 Service Usage, v1 IAM):**
1. `GET https://cloudresourcemanager.googleapis.com/v3/projects/projects%2F{projectId}` — actually use `GET /v3/projects/{projectId}`; 403/404 → create: `POST /v3/projects` body `{ projectId, displayName: "iam-engine {slug}" }`; poll returned operation `GET /v3/{operation.name}` until `done` (max 12×5s). If create fails with an org-policy error mentioning parent, `GET /v3/organizations:search` and retry create with `parent: organizations/{orgId}` (first result).
2. `POST https://serviceusage.googleapis.com/v1/projects/{projectId}/services:batchEnable` body `{ serviceIds: ["admin.googleapis.com", "iam.googleapis.com"] }`; poll operation until done (max 12×5s).
3. `GET https://iam.googleapis.com/v1/projects/{projectId}/serviceAccounts/iam-engine@{projectId}.iam.gserviceaccount.com`; 404 → `POST /v1/projects/{projectId}/serviceAccounts` body `{ accountId: "iam-engine", serviceAccount: { displayName: "iam-engine (Coretelligent IAM)" } }`. Newly-created SAs can 404 on immediate re-read — treat the create response as authoritative. Capture `uniqueId`, `email`.
4. Key, only when `needKey`: `POST /v1/projects/{projectId}/serviceAccounts/{email}/keys` body `{}` → response `privateKeyData` (already base64 of the JSON key) and `name`. `credState = "issued"`; else `"kept-valid"` with no key call.

- [ ] **Step 1:** Failing tests (mock fetcher with a scripted request log): `projectIdForSlug("drive-capital")` → `ctg-iam-drive-capital`; a 34-char slug truncates to 30 with no trailing `-`; happy path returns all fields with `credState:"issued"` and `keyBase64` = the mocked `privateKeyData`; existing-project + existing-SA + `needKey:false` → `kept-valid`, no key request issued (assert on the request log); project-create org-policy failure retries with parent and succeeds; any step's terminal failure → `{ok:false}` with an `actions` trail and **no key material in `error` or `actions`**.
- [ ] **Step 2:** Run tests — FAIL. **Step 3:** Implement (small `call()` helper: JSON fetch, bearer header, returns `{status, body}`; never throws). **Step 4:** Tests pass. **Step 5:** Commit `feat: Google Cloud provisioning (project, Admin SDK, service account, key)`.

---

### Task 4: `google-verify.ts` — SA JWT + directory probe

**Files:**
- Create: `web/lib/secrets/google-verify.ts`, `.test.ts`

**Interfaces:**
- Produces (Tasks 5, 7 consume):

```ts
export const DWD_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.orgunit",
  "https://www.googleapis.com/auth/admin.directory.user.security",
] as const;
export function signSaJwt(input: { saEmail: string; impersonate: string; privateKeyPem: string; scopes: readonly string[]; nowSec?: number }): string; // RS256 via node:crypto createSign("RSA-SHA256")
export function keyPemFromBase64Json(keyBase64: string): { saEmail: string; privateKeyPem: string } | null; // decode base64 → JSON key file → {client_email, private_key}
export async function probeGoogleDirectory(input: {
  keyBase64: string; impersonate: string; fetcher?: typeof fetch; nowSec?: number;
}): Promise<{ ok: true; customerId?: string } | { ok: false; error: string }>;
// JWT-bearer exchange at oauth2.googleapis.com/token (grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer),
// then GET https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=1 —
// customerId harvested from the first user row when present.
export async function probeWithDwdRetry(
  input: Parameters<typeof probeGoogleDirectory>[0],
  opts?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<{ ok: boolean; customerId?: string; error?: string }>; // default 8 attempts × 15s; retry ONLY on unauthorized_client / access_denied / 403 (DWD propagation); other errors fail fast
```

- [ ] **Step 1:** Failing tests: generate a real RSA keypair in-test (`node:crypto generateKeyPairSync("rsa", {modulusLength: 2048})`), assert `signSaJwt` output verifies with `crypto.verify` and its decoded claims carry `iss`, `sub`, `aud:"https://oauth2.googleapis.com/token"`, space-joined scopes, `exp = iat + 3600`; `keyPemFromBase64Json` round-trips and returns null on garbage; `probeGoogleDirectory` happy path (mock fetcher: token 200 → users 200 with `users:[{customerId:"C0abc1234"}]`) → `{ok:true, customerId:"C0abc1234"}`; `probeWithDwdRetry` with fetcher returning `unauthorized_client` twice then success (injected zero-delay `sleep`) → ok after 3 attempts; a 400 `invalid_grant` fails fast (1 attempt).
- [ ] **Steps 2–5:** Red → implement → green → commit `feat: Google SA JWT verification probe with DWD propagation retry`.

---

### Task 5: `write-google-workspace.ts` + registries

**Files:**
- Create: `web/lib/secrets/write-google-workspace.ts`, `.test.ts`
- Modify: `web/lib/secrets/field-requirements.ts`, `web/lib/secrets/delinea-templates.ts`, `web/lib/secrets/value-probe.ts` (+ their colocated tests)

**Interfaces:**
- Consumes: `GoogleProvision` (Task 3), `probeGoogleDirectory` (Task 4), Delinea layer (`createSecret`, `updateSecretFields`, `findChildFolderByName`), `makeClientRepository(db).upsertSecrets`, `templateFor`/`folderIdFor`/`identitySubfolderName`/`delineaWriteConfigured` — read `write-m365-app.ts` first; this file mirrors its structure.
- Produces (Task 7 consumes):

```ts
export async function writeGoogleWorkspaceCreds(input: {
  db: PrismaClient; client: { id: string; slug: string; name: string; delineaFolderId: string | null };
  provision: GoogleProvision; impersonate: string; customerId?: string;
}): Promise<
  | { ok: true; externalId: string; actions: string[] }
  | { ok: false; stranded?: boolean; error: string; actions: string[] }
>;
export const GOOGLE_SECRET_NAME = "Google API - IAM Engine";
export function googleLabeledValues(p: { keyBase64: string; saEmail: string; impersonate: string; customerId?: string }): Record<string, string>;
// { ClientID: customerId ?? "my_customer", ClientSecret: keyBase64, accountid: saEmail, apiURL: impersonate }
```

**Behavior (mirror `write-m365-app.ts` decision order):** `kept-valid` + no real vaulted id (`secretIsSet` false) → return `{ok:false, stranded:true}` (core re-provisions with `needKey:true`); `kept-valid` + vaulted → stamp label `(auto)` only, `ok:true` with existing externalId; `issued` → gate on `delineaWriteConfigured`, resolve the client folder's **Identity Services** subfolder, create-or-update secret named `Google API - IAM Engine` (update in place when a real vaulted id exists), then `upsertSecrets(clientId, [{ name: "google-admin", externalId, label: "Google service account (auto)" }])` and self-learn `delineaFolderId`.

**Registry edits:**
1. `field-requirements.ts`: add `"google-admin"` entry — required fields `ClientSecret` (hint: "Base64 of the service-account JSON key file"), `accountid` (SA client email), `apiURL` (impersonated super-admin email); optional `ClientID` (customer ID). Follow the file's existing entry shape exactly.
2. `delinea-templates.ts`: `DEFAULT_TEMPLATE_NAMES["google-admin"] = "Automation - API"`.
3. `value-probe.ts`: register a **blocking** `google-admin` probe delegating to `probeGoogleDirectory` (decode via `keyPemFromBase64Json`; `impersonate` from the `apiURL` field). Follow the registry's existing m365 entry shape.

- [ ] **Step 1:** Failing tests: `googleLabeledValues` exact mapping incl. `my_customer` default; stranded path; kept-valid label stamp with no Delinea write (assert createSecret/updateSecretFields not called); issued path calls createSecret with template name from `templateFor("google-admin")`, secret name `Google API - IAM Engine`, Identity Services folder, then upsertSecrets with the wire label; update-in-place when vaulted id real; Delinea write failure → `{ok:false}` with actions and no `keyBase64` echoed. Registry tests: field-requirements entry present with the 3 required + 1 optional; template default resolves; value-probe registered + blocking.
- [ ] **Steps 2–5:** Red → implement → green → commit `feat: vault google-admin on Automation - API template + registries`.

---

### Task 6: `dispatch-google-browser-job.ts`

**Files:**
- Create: `web/lib/secrets/dispatch-google-browser-job.ts`, `.test.ts`
- Modify (only if needed after reading it): `web/lib/cases/exclude-m365-autosetup.ts` + its test — the case-queue exclusion must also hide google auto-setup cases.
- Modify: `web/lib/jobs/adhoc.ts` — add the two systemKey constants beside `ENTRA_DEVICECODE_KEY`.

**Interfaces:**
- Consumes: read `dispatch-device-code-job.ts` first — mirror its synthetic CaseRequest + Job shape (`singleRun: true`, marker payload, `secretOverrides`).
- Produces (Task 7 consumes; Task 11's runner flows receive these payloads):

```ts
// web/lib/jobs/adhoc.ts
export const GOOGLE_OAUTH_SIGNIN_KEY = "google-oauth-signin";
export const GOOGLE_DWD_GRANT_KEY = "google-dwd-grant";

// dispatch-google-browser-job.ts
export async function dispatchGoogleOAuthJob(input: {
  db: PrismaClient; client: { id: string; slug: string; name: string };
  seedSecretRef: string;            // rides secretOverrides["google-super-admin"]
  authUrl: string;                  // full accounts.google.com URL (challenge embedded)
  redirectUri: string;              // for the flow's capture matcher
}): Promise<{ ok: true; jobId: string } | { ok: false; error: string }>;
export async function dispatchGoogleDwdJob(input: {
  db: PrismaClient; client: { id: string; slug: string; name: string };
  seedSecretRef: string;
  saClientId: string; scopes: readonly string[];
}): Promise<{ ok: true; jobId: string } | { ok: false; error: string }>;
```

Job `config` carries `{ authUrl, redirectUri }` / `{ saClientId, scopes }` (non-secret). Use the same auto-setup marker the m365 dispatch stamps so `notM365AutoSetupCase` (or its widened successor) hides these cases — if the marker is m365-named, widen the helper minimally (e.g. accept a second marker constant) **without changing its behavior for existing rows**, and update its test.

- [ ] **Step 1:** Failing tests mirroring `dispatch-device-code-job.test.ts`: job row has the right systemKey, `singleRun`, config payload, `secretOverrides["google-super-admin"] = seedSecretRef`, marker present; exclusion helper hides a google-marker case and still hides an m365-marker case.
- [ ] **Steps 2–5:** Red → implement → green → commit `feat: dispatch google oauth/dwd browser jobs`.

---

### Task 7: `setup-google-client.ts` core + `setup-google-deps.ts`

**Files:**
- Create: `web/lib/secrets/setup-google-client.ts`, `.test.ts`, `web/lib/secrets/setup-google-deps.ts`, `.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6. Read `setup-m365-client.ts` + `setup-m365-deps.ts` first — mirror the `callDep` wrapper, `onStage` reporter, and deps-bundle pattern.
- Produces (Task 8 consumes):

```ts
export type GoogleSetupStage =
  | "eligibility" | "oauth-dispatch" | "oauth-code" | "provision"
  | "dwd-dispatch" | "dwd-grant" | "verify" | "write" | "done" | "error";
export type GoogleSetupResult = {
  stage: GoogleSetupStage; ok: boolean;
  saEmail?: string; saClientId?: string; externalId?: string;
  verified?: boolean; customerId?: string;
  userAction?: { kind: "dwd"; clientId: string; scopes: string[] }; // manual fallback card
  browserWarnings: string[]; actions: string[]; error?: string;
};
export async function setupGoogleForClient(input: {
  client: { id: string; slug: string; name: string; delineaFolderId: string | null };
  seedSecretRef: string; forceRotate: boolean;
  deps: GoogleSetupDeps; onStage?: (stage: GoogleSetupStage, extra?: Partial<GoogleSetupResult>) => Promise<void>;
}): Promise<GoogleSetupResult>;

export type GoogleSetupDeps = {
  hasGoogleSystem(clientId: string): Promise<boolean>;
  readSeedUsername(seedSecretRef: string): Promise<string | null>; // resolveSecretFields → Username; null if unreadable/non-email
  vaultedKeyPresent(clientId: string): Promise<boolean>;           // google-admin slot has a real id (secretIsSet)
  makePkce(): PkcePair; buildAuthUrl(challenge: string, loginHint: string): string;
  dispatchOAuthJob(...): ...; awaitJobResult(jobId: string, timeoutMs: number): Promise<{ ok: boolean; resultText?: string; warnings: string[] }>;
  exchangeCode(code: string, verifier: string): Promise<...>;
  provision(...): ...; dispatchDwdJob(...): ...;
  probeWithRetry(...): ...; write(...): ...; deleteIssuedKey(keyName: string, accessToken: string): Promise<boolean>;
};
```

**Stage logic (each dep behind `callDep`; every transition calls `onStage`):**
1. `eligibility`: no `google-workspace` system → terminal error "client has no google-workspace system"; `readSeedUsername` null → terminal error (Impersonate unknown).
2. `oauth-dispatch` → `oauth-code`: dispatch OAuth job with `buildAuthUrl(challenge, seedUsername)`; await job result (timeout 15 min); parse the auth code from the job's result text (the flow returns `OAUTH_CODE:<code>` on its own line); job warnings → `browserWarnings`.
3. `provision`: exchange code (PKCE verifier held in a local), then `provision({ needKey: forceRotate || !(await vaultedKeyPresent()) })`.
4. `dwd-dispatch` → `dwd-grant`: dispatch DWD job with `saClientId` + `DWD_SCOPES`; await (timeout 10 min). **On failure: do NOT terminal-error** — set `userAction = { kind:"dwd", clientId: saClientId, scopes: [...DWD_SCOPES] }`, still proceed to `verify` (the operator may paste the grant while we retry).
5. `verify`: only when a key is in hand (`issued`) or vaulted (`kept-valid`); `probeWithRetry`. Failure → `verified:false`, keep going (never block the write on propagation).
6. `write`: `write(...)`; on `{stranded:true}` → exactly one re-provision with `needKey:true` and re-write (mirror the m365 recovery). After a successful `issued` write **and** `verified===true`, best-effort `deleteIssuedKey` for a rotated-away prior key IF this run's provision reported one — skip silently otherwise.
7. `done`: ok when write succeeded; `userAction` present → the run-client status becomes `needs_action` (Task 8 maps it); `verified` carried through.

`setup-google-deps.ts` (`buildGoogleSetupDeps(db)`) wires the real implementations: `awaitJobResult` polls the Job row (5 s interval) for terminal status, extracting WARN lines the way `extractWarnings` does for m365 (reuse that helper if exported, else replicate its regex in this file).

- [ ] **Step 1:** Failing tests with full in-memory deps (mirror `setup-m365-client.test.ts` style): happy path hits stages in order and returns externalId+verified; no-system and no-username terminal errors; OAuth job timeout → error at `oauth-code`; DWD job failure → `userAction` set, run still reaches `write` and `done`; verify propagation failure → `verified:false` but write happens; stranded → exactly one re-provision (assert provision called twice, second with `needKey:true`); forceRotate forces `needKey:true`; key cleanup called only when issued+verified+priorKey.
- [ ] **Steps 2–5:** Red → implement → green → commit `feat: setupGoogleForClient DI core with DWD manual fallback`.

---

### Task 8: `google-setup-run.ts` + API routes

**Files:**
- Create: `web/lib/secrets/google-setup-run.ts`, `.test.ts`, `web/app/api/clients/[slug]/google-setup/route.ts`
- Reference: `m365-setup-run.ts`, `web/app/api/clients/[slug]/m365-setup/route.ts` (mirror auth gates, 409 semantics, polling GET)

**Interfaces:**
- Produces:

```ts
export async function startGoogleSetupRun(db, input: {
  client: { id: string; slug: string; name: string; delineaFolderId: string | null };
  startedBy: string; seedSecretRef: string; forceRotate: boolean;
  runSetup: (onStage) => Promise<GoogleSetupResult>;
}): Promise<{ started: true; id: string } | { started: false; reason: string }>;
export async function latestGoogleSetupRun(db, clientId: string): Promise<RunView | null>;
```

- One live run per `client:{id}` scope (reject with `{started:false, reason:"already running"}` when a run row is `running` and fresher than the 3 h staleness cutoff — same reap rule as m365). Detach work with `void (async () => ...)()`. Persist `stage`/`saClientId`/`userAction`/`log` via `onStage`; terminal mapping: result.ok && !userAction → `done`; result.ok && userAction → `needs_action`; else `failed`.
- **Route POST:** gate `client.edit_secrets` + client scope (copy the m365 route's gate calls exactly); body `{ seedSecretRef: string; forceRotate?: boolean }`; 400 without seedSecretRef; audit `google.setup.start`; build deps via `buildGoogleSetupDeps(db)`; 409 with reason when not started.
- **Route GET:** latest run view; when terminal `done`/`needs_action`, include the wired `google-admin` externalId (via `secretIsSet` check) **and** trigger-once semantics for the conn test: if run is `done`/`needs_action`+verified and no `ConnectionTest` row for this client's `google-workspace` system is newer than the run's `finishedAt`, call `makeRunnerService(db).requestConnectionTests(slug, "google-workspace", "google-setup")` and record in the run log; always include the newest google-workspace conn-test verdict in the GET payload.
- [ ] **Step 1:** Failing tests for `google-setup-run.ts` (mirror `m365-setup-run.test.ts`): start/duplicate-409/stale-allows-new; stage persistence; terminal mapping incl. `needs_action`; conn-test trigger fires exactly once (fake runner service, call GET twice).
- [ ] **Steps 2–5:** Red → implement → green (route logic beyond the lifecycle lives thin; test through the lifecycle module) → commit `feat: google-setup run lifecycle + client routes with auto conn test`.

---

### Task 9: UI — `GoogleSetupButton` + menu

**Files:**
- Create: `web/app/clients/_components/google-setup-button.tsx`
- Modify: `web/app/clients/_components/client-actions-menu.tsx`
- Reference: `m365-setup-button.tsx` (mirror dialog/two-phase/polling/openSignal patterns and its styling exactly)

**Behavior:**
- Menu item "Set up Google Workspace automatically", rendered only when the client has a `google-workspace` system (the menu already knows the client's systems — follow how the M365 item gates, and if it doesn't gate, pass a `hasGoogle` prop from the page the same way `slug` flows).
- Form phase: one required input "Super-admin login — Delinea secret ID" (`seedSecretRef`), checkbox "Rotate the service-account key" (`forceRotate`, default off). POST `/api/clients/{slug}/google-setup`.
- Progress phase: 3 s polling GET; 5-step tracker mapping stages: `oauth-*` → "Sign in to Google", `provision` → "Create the service account", `dwd-*` → "Grant domain-wide delegation", `verify`+`write` → "Save the credential to Delinea", terminal → "Test the connection" (verdict from the GET payload). `needs_action` renders the manual-DWD card: SA client ID (copy button), comma-joined scope string (copy button), instructions line ("Admin console → Security → Access and data control → API controls → Domain-wide delegation → Add new"), and a "Verify again" button that POSTs again with the same inputs (re-run is idempotent). Show `externalId` when wired, collapsible run log, Re-run. `router.refresh()` once on terminal (mirror `refreshedOnDone`).
- Copy buttons: use the same copy helper the m365 modal uses (secure-context-safe — the clipboard gotcha).
- [ ] **Step 1:** If `m365-setup-button` has component tests, mirror them; otherwise add a small pure-helper test file for the `stepOf(stage)` mapping (export it) covering every stage → step index incl. `needs_action`.
- [ ] **Steps 2–5:** Red → implement → green; `npx tsc --noEmit`; commit `feat: Set up Google Workspace automatically modal + menu item`.

---

### Task 10: Runner — `Use-CtgGoogleSecret` Automation - API shapes + module docs

**Files:**
- Modify: `runner/modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1` (`Use-CtgGoogleSecret`, ~line 574 area of Start-IamRunner references it — the function lives in the psm1)
- Modify: `docs/modules/google-workspace.md`
- Test: add/extend Pester in `runner/tests/` (find the existing GoogleWorkspace Pester file; create `runner/tests/GoogleWorkspace.Secret.Tests.ps1` if none)

**Behavior (additive — existing shapes keep working):**
- New accepted fields, checked **after** the existing `$pick` chain misses: `ClientSecret` (key material), `accountid` (client email), `apiURL` (impersonate), `ClientID` (customer id).
- `ClientSecret` decode ladder: value starts `-----BEGIN` → treat as PEM (needs `accountid` for email); starts `{` → full JSON key; else base64-decode and re-run the same two checks; still neither → throw the module's standard "unrecognized google credential shape" error.
- `apiURL` maps to Impersonate **only when it contains `@`** (it's an email, not a URL, per the template repurposing); `ClientID` maps to CustomerId only when non-empty, else `my_customer`.
- `docs/modules/google-workspace.md`: document the "Automation - API" template as the canonical vaulted shape (table: template field → meaning), note base64 requirement and that `apiURL` holds the impersonate email — per Evan's instruction to update the module docs to match.
- [ ] **Step 1:** Pester red: base64-JSON-in-ClientSecret + accountid + apiURL resolves email/key/impersonate/customer; base64-PEM variant; raw-JSON variant; legacy `ServiceAccountKeyBase64` still works; garbage throws.
- [ ] **Steps 2–5:** Red → implement → green (`~/.local/pwsh/pwsh -Command "Invoke-Pester runner/tests/GoogleWorkspace.Secret.Tests.ps1 -Output Detailed"`) → commit `feat(runner): Automation - API credential shape for google-admin + module docs`.

---

### Task 11: Runner — browser flows + dispatch entries + VERSION

**Files:**
- Create: `runner/browser/flows/google-oauth-signin.mjs`, `runner/browser/flows/google-dwd-grant.mjs` (+ colocated `.test.mjs` mirroring `spanning-force-sync.test.mjs`'s harness for parse/pure helpers)
- Modify: `runner/Start-IamRunner.ps1` (two `$DISPATCH` entries beside `entra-devicecode`, ~line 1522; both browser-capability-gated the same way), `runner/VERSION` → `1.79.0`
- Reference: `runner/browser/flows/entra-devicecode.mjs` + its PS wrapper `Invoke-CtgEntraDeviceCode` — mirror the flow structure, secret/OTP brokering (`OtpRequest` hash), WARN-line convention, and result-text contract.

**Flow contracts (must match Tasks 6–7 exactly):**
- `google-oauth-signin`: job config `{ authUrl, redirectUri }`; secret `google-super-admin` (Username/Password + OTP via the OtpRequest broker). Navigate to `authUrl`; Google sign-in (email → Next → password → Next → TOTP when challenged → consent screen "Allow"/"Continue"). Capture the redirect to `redirectUri` **without serving it**: register `page.route(redirectUri + "*", …)` fulfilling a tiny "You may close this window" body while extracting `code` from the request URL (fallback: catch the navigation failure and parse `page.url()`). Print `OAUTH_CODE:<code>` as the flow's result line. Hidden-element discipline per the MS-login lesson: assert the focused/enabled input before typing; detect "typed password, no nav, no error" and emit `WARN` lines for soft failures (unexpected challenge page, passkey interstitial → click "Try another way" → TOTP).
- `google-dwd-grant`: job config `{ saClientId, scopes }`; sign in the same way, go to `https://admin.google.com/ac/owl/domainwidedelegation`; if a row for `saClientId` exists, open it and reconcile scopes (union); else "Add new" → paste client ID + comma-joined scopes → Authorize; read the table back and print `DWD_GRANTED:<saClientId>` only when the row shows all requested scopes; otherwise exit nonzero with WARN lines.
- PS side: `Invoke-CtgGoogleOAuthSignin` / `Invoke-CtgGoogleDwdGrant` wrappers (in the GoogleWorkspace psm1, exported in the psd1 — remember FunctionsToExport parity) + the two `$DISPATCH` entries mapping Onboard=Offboard like `entra-devicecode`.
- [ ] **Step 1:** `.test.mjs` red for the pure helpers (code-from-URL parser; scope-union reconciler; result-line formatters) — full-browser paths are exercised live in Task 12, not in unit tests.
- [ ] **Steps 2–5:** Red → implement → green (`node --test runner/browser/flows/google-oauth-signin.test.mjs` etc. — match how existing `.test.mjs` are run; check `runner/browser/package.json` scripts) → bump VERSION to 1.79.0 → Pester smoke `Invoke-Pester runner/tests -Output Minimal` still green → commit `feat(runner): google oauth-signin + dwd-grant browser flows (1.79.0)`.

---

### Task 12: Changelog + whole-feature verification

**Files:**
- Create: `web/lib/changelog/entries/<next-id>-google-workspace-auto-setup.ts` (mirror a recent entry file; register in `_registry.ts`, id-sorted; `time` = `TZ=America/New_York date +%H:%M` rounded to a 15-min boundary; overview-style entry describing the feature)
- No other code changes unless verification fails.

- [ ] **Step 1:** Full web suite: `cd web && npx vitest run` — all green. `npx tsc --noEmit` green.
- [ ] **Step 2:** Full Pester: `~/.local/pwsh/pwsh -Command "Invoke-Pester runner/tests -Output Minimal"` — green.
- [ ] **Step 3:** Grep gate: `git grep -n "keyBase64" -- web/lib/secrets | grep -i "log\|audit\|actions.push"` returns nothing that writes key material into logs/actions; `git diff main --stat` touches no m365-named file.
- [ ] **Step 4:** Changelog entry + commit `chore: changelog for Set up Google Workspace automatically`.

---

## Live validation (post-merge, operator-driven — not a plan task)

On the dev server per `web-dev-verify-recipe`: Drive Capital → Actions → Set up Google Workspace automatically → seed `8404` → expect sign-in job, provision, DWD grant (or manual card), Delinea secret `Google API - IAM Engine` on Automation - API (fallback: create a "Google Service Account" template and set `DELINEA_TEMPLATE_GOOGLE_ADMIN`), `google-admin` wired "(auto)", conn test green. Template field-name casing mismatches are fixed via env, not code.
