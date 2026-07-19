# Automated M365 app-registration setup — design spec

**Date:** 2026-07-19
**Status:** Brainstorming. This spec covers the **program roadmap** (5 phases) plus the detailed design of **Phase 1** (the Graph provisioning core). Later phases get their own spec → plan → build cycles.

## Context

Credential wiring is the #1 client-setup bottleneck (identified in the earlier fleet review): every `api` system needs a Delinea reference, and the `m365-admin` credential specifically **must be an Entra app registration** (a Global-Admin *user* account can never do the client-credentials grant — `AADSTS700016`). Today an operator creates that app registration by hand in the Entra portal, grants + admin-consents ~10 Graph app roles, then pastes the app id / secret / tenant into Delinea. Across ~200–500 clients this is the dominant manual cost.

**Goal:** automate it — for one client or fleet-wide: find the client's Global-Admin login in Delinea (by CORE id), authenticate, create/configure the `iam-engine` app registration with the right permissions, admin-consent them, and write the resulting credentials back into Delinea under that client.

## Foundations that already exist (reused, not rebuilt)
- **MS-365 SSO browser login** — `runner/browser/flows/spanning-force-sync.mjs` already drives `login.microsoftonline.com` end-to-end: the `onActiveView` single-page gotcha, KMSI, MS-error detection, and **TOTP MFA via a Delinea-minted one-time code** (`mintOtp` → `/api/jobs/[id]/credential`). **Push / number-match / SMS MFA is a hard stop** (a headless bot can't approve). Sidecar plumbing: `run-flow.mjs` + `lib/launch.mjs` + `Coretelligent.Browser.psm1`; `browser` capability keeps such jobs on the central runner.
- **The permission model** — `web/lib/secrets/graph-caps.ts`: `GRAPH_REQUIRED_CAPS`, `GRAPH_OPTIONAL_CAPS`, `GRAPH_APP_ROLE_IDS` (the *application* role GUIDs), `GRAPH_RESOURCE_APP_ID`. `readGrantedAppRoles()` (`graph-app-roles.ts`) reads what an app actually holds; `graphCapGaps()` computes what's missing. `probeEntraClientCredentials()` (`m365-credential.ts`) validates an app registration works.
- **Delinea read/write** — `web/lib/secrets/delinea.ts` (`resolveSecretFields`, `getOneTimePasswordCode`, `createSecret`), the create route + template model (`delinea-templates.ts`, env-driven template ids + fieldMap), folder-by-CORE-id (`Client.coreId` → `Client.delineaFolderId`, discovered via the `\Clients\<name> !CORE###!` naming in `recovery-match.ts`).
- **Fleet orchestration** — the m365-audit sweep pattern (`web/lib/audits/m365-audit.ts`: `startRun`, one Delinea token reused, iterate `auditTargets`, `onProgress`, 409-if-running), `fleetWideAccess()` + restricted-client scoping.
- **Greenfield:** nothing creates/configures an app registration today (only read/audit) — the provisioning is new.

## Architecture decision (locked)
**Browser-auth → Graph API**, not portal-clicking. The browser does *only* the standard MS interactive login (reusing the spanning SSO machinery) to obtain a **delegated Graph token carrying the GA's privileges**; the **Graph API** then deterministically creates the app, attaches secret+cert, sets `requiredResourceAccess`, and admin-consents the app roles. The Azure portal is a heavy dynamic SPA — driving its blades with Playwright is fragile and untestable; Graph-API-after-auth is deterministic, idempotent, and unit-testable, and reuses the permission model wholesale.

## Phase roadmap
1. **Graph provisioning core** *(this spec)* — deterministic, browser-free, testable. Create/configure/consent the app via Graph API given a GA token.
2. **Browser GA-auth → Graph token** — a flow (reusing spanning SSO) that yields the delegated token Phase 1 needs. TOTP-MFA via Delinea; push/SMS = clear hard-stop.
3. **Delinea write-back** — vault `{appId, secret, cert}` under the client via `createSecret` + an **extended `m365-admin` template** (add cert fields — today it's app-id/secret/tenant only), validated by `probeEntraClientCredentials` before writing.
4. **Per-client orchestration + UI** — a "Set up M365 automatically" action tying resolve-GA-login → Phase 2 → Phase 1 → Phase 3 → verify, with preview/confirm + idempotency.
5. **Fleet run** — a `startRun`-backed sweep over many/all clients (m365-audit pattern), `fleetWideAccess` + restricted scoping, `onlyClient`, and safety gates (TOTP-seed precondition, dry-run, per-client skip when the GA MFA can't be automated).

---

## Phase 1 — Graph provisioning core (detailed design)

### Locked decisions
- **Default permission set:** `GRAPH_REQUIRED_CAPS` **+ all** `GRAPH_OPTIONAL_CAPS` (every engine feature works out of the box; the rights test then reads fully green).
- **Credentials:** issue **both** a client secret (Graph works immediately) **and** a self-signed cert (needed later for Exchange Online app-only); store both.
- **Re-run:** **reconcile permissions; keep existing credentials** — add any missing app-role grants, but do NOT mint a new secret/cert when a valid one exists (never silently rotate a working, vaulted credential); issue creds only when none exist or the existing one is expired.

### Component
A new TypeScript module `web/lib/secrets/provision-m365-app.ts` — pure Graph REST over an injected `fetch` (mirrors `graph-app-roles.ts`'s `GraphFetch` + retry/`complete` discipline so a throttled call never corrupts a decision).

**Interface:**
```ts
type ProvisionInput = {
  graphToken: string;   // a DELEGATED Graph token with GA privileges (from Phase 2, or hand-obtained for validation)
  tenantId: string;
  caps?: "required+optional" | "required";  // default "required+optional"
  issueCreds?: boolean; // default: issue when absent/expired only (the reconcile rule)
};
type ProvisionResult = {
  appId: string; objectId: string; spId: string; tenantId: string;
  clientSecret?: string;       // present only when a NEW secret was issued this run
  certBase64?: string; certPassword?: string; // present only when a NEW cert was issued this run
  created: boolean;            // true if the app registration was created (vs found existing)
  granted: string[];           // app roles now consented
  gaps: string[];              // required roles still missing (should be empty on success)
  actions: string[];           // human-readable log of what was done
};
export async function provisionM365App(input: ProvisionInput, fetcher?: GraphFetch): Promise<ProvisionResult>;
```

### Graph steps (idempotent)
1. **Find-or-create** the app. Match a stable marker so a re-run never duplicates: `GET /applications?$filter=displayName eq 'iam-engine'` AND a tag (`tags: ["ctg:iam-engine"]`) to disambiguate from any coincidental name. If none → `POST /applications { displayName: "iam-engine", signInAudience: "AzureADMyOrg", tags: ["ctg:iam-engine"], requiredResourceAccess: <built below> }`. If found → PATCH `requiredResourceAccess` to the union (reconcile).
2. **`requiredResourceAccess`** — one `resourceAccess` entry per chosen cap's suggested role (`suggestedRole(cap)` → `GRAPH_APP_ROLE_IDS[role]`), `type: "Role"`, `resourceAppId: GRAPH_RESOURCE_APP_ID`. Caps = required (+ optional when default).
3. **Service principal** — `GET /servicePrincipals?$filter=appId eq '{appId}'`; if none `POST /servicePrincipals { appId }`. Also resolve the **Graph resource SP** id in the tenant (`GET /servicePrincipals?$filter=appId eq '{GRAPH_RESOURCE_APP_ID}'`) for the assignments.
4. **Admin-consent** = create app-role assignments: for each required/chosen role not already assigned, `POST /servicePrincipals/{graphSpId}/appRoleAssignedTo { principalId: <appSpId>, resourceId: <graphSpId>, appRoleId: <roleId> }`. Skip ones already present (reconcile). This is the step that genuinely needs the GA-delegated `AppRoleAssignment.ReadWrite.All`.
5. **Credentials** (only when issuing per the reconcile rule):
   - Secret: `POST /applications/{objectId}/addPassword { passwordCredential: { displayName: "ctg-secret" } }` → capture `secretText` once.
   - Cert: generate a self-signed X.509 keypair in Node (see below); `PATCH /applications/{objectId}` adding a `keyCredentials` entry (the public cert, base64 DER, `type: "AsymmetricX509Cert"`, `usage: "Verify"`). Keep the private key → return pfx base64 + a generated password.
6. **Verify** — `readGrantedAppRoles(graphToken-or-app-token, appId)` and `graphCapGaps` → populate `granted`/`gaps`. (Reuse the existing reader; a non-empty `gaps` on required roles = a surfaced error, not a silent pass.)

### Cert generation
Generate an RSA-2048 self-signed cert + PKCS#12 in Node. Use a maintained pure-JS library so there's no `openssl` shell dependency on the runner/host — **`@peculiar/x509` + `node-forge`** (or `@peculiar/x509` alone for the cert and its pkcs12) — decide the exact lib in the plan; it's a new devDependency-class addition to `web/`. The private key never leaves this function except as the returned `certBase64`/`certPassword` (which Phase 3 vaults); it is never logged.

### Error handling
Every Graph call goes through the `graph-app-roles.ts`-style wrapper (status + translated message; retry on 429/5xx). Specific translations: a delegated token lacking `Application.ReadWrite.All` / `AppRoleAssignment.ReadWrite.All` → a clear "the signed-in account needs Global Admin + these delegated scopes" message (this is really a Phase 2 token-scope concern, surfaced here). `readGrantedAppRoles`'s existing "couldn't verify vs granted-nothing" distinction is preserved — never report success on an unverified consent.

### Testing
Inject a mock `GraphFetch`; unit-test: create-new (no existing app), find-existing + reconcile (adds only missing roles, issues no new creds when one exists), consent skips already-assigned roles, `gaps` populated when a role assignment fails, cert/secret returned only when issued. No tenant required. Then a **manual live validation** against a real tenant with a hand-obtained GA token (documented runbook), before Phase 2 automates the token.

### Non-goals (Phase 1)
- `Exchange.ManageAsApp` (Office 365 Exchange Online resource) + the **Exchange Administrator** directory-role assignment — materially harder (non-Graph resource + `roleManagement` assignment); its own follow-on. Phase 1 yields a **Graph-complete** credential.
- SharePoint `Sites.FullControl.All` (SharePoint resource).
- The browser token acquisition (Phase 2), Delinea write-back (Phase 3), orchestration/UI (Phase 4), fleet run (Phase 5).
- Secret/cert rotation policy beyond "issue when absent/expired."

### Verification (Phase 1 done when)
Unit tests green (mocked Graph); a documented live run against one real tenant creates the app, consents required+optional Graph roles, returns a working `{appId, secret, cert, tenant}` that `probeEntraClientCredentials` accepts and `readGrantedAppRoles` shows zero required gaps.
