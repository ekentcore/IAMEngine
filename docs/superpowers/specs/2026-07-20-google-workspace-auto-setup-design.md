# Set up Google Workspace automatically — design

Date: 2026-07-20
Status: approved by Evan (approach + template mapping), pending spec review
Related: `docs/superpowers/specs/2026-07-19-m365-auto-setup-design.md` (the pattern this
mirrors), `docs/modules/google-workspace.md` (runner module spec — updated by this work)

## Goal

One-click provisioning of Google Workspace API access for a client, mirroring "Set up
M365 automatically": the operator enters the Delinea secret ID of the client's Google
super-admin login (for Drive Capital: **8404**, labeled "Google Admin / JAMF"), and the
app creates the service-account credential, vaults it in Delinea, wires the new Delinea
ID into the client's `google-admin` slot, and runs the Google connection test to prove
it works.

Success criteria (validated live on Drive Capital, our first G Suite client):

1. Enter 8404 in the modal → run completes without manual console work (or degrades to
   one copy-paste fallback for the delegation grant).
2. A "Google API - IAM Engine" secret exists in the client's Delinea folder
   ("Identity Services" subfolder), on the **Automation - API** template.
3. The client's `google-admin` secret slot holds the new Delinea ID with an "(auto)"
   label in the Secrets panel.
4. The `google-workspace` connection test passes using only the vaulted credential.

## Why this shape (context)

The runner already speaks Google: `Coretelligent.GoogleWorkspace` authenticates with a
**service account + domain-wide delegation** (RS256 JWT, `sub` = impersonated super
admin) and a `google-workspace` conn-test probe exists. What's missing is everything
upstream: there is no way to *create* that service account automatically, and no
`google-admin` entries in the app's Delinea template/field registries.

Unlike Entra, Google has no device-code path for this. Creating the credential means:
GCP project → enable Admin SDK → service account → JSON key → **domain-wide delegation
grant in admin.google.com**, and the delegation grant has no public API at all.

**Chosen approach (Evan-approved): API-first with two narrow browser steps.** Playwright
handles only the stable surfaces — the Google sign-in + one OAuth consent screen, and
the single delegation-grant admin page. Everything in between (project, APIs, service
account, key) is plain REST against Google Cloud APIs. Rejected alternatives: full
browser automation of the Cloud Console (large fragile SPA surface) and a guided manual
wizard (reliable but not "automatically").

## Architecture

New, parallel pipeline modeled on the M365 one. **No changes to the M365 flow or its
tables** (it just went live). No shared provider registry yet — two providers don't
justify one.

### Run stages

| Stage | Where | What happens |
|---|---|---|
| 1. Sign in & authorize | runner (browser job) | Sign into Google as super admin (seed secret + Delinea-minted OTP), complete one OAuth consent, capture the authorization code |
| 2. Provision | app (REST) | Exchange code → token; find-or-create project, enable APIs, find-or-create service account, issue key |
| 3. Delegation grant | runner (browser job) | Add/update the domain-wide delegation entry in admin.google.com |
| 4. Verify | app (REST) | Sign a JWT as the SA impersonating the super admin; `GET /users?maxResults=1` |
| 5. Vault & wire | app | Create-or-update the Delinea secret; wire its ID into the client with "(auto)" |
| 6. Connection test | app → runner | Auto-trigger the existing `google-workspace` conn test; surface the verdict |

### Stage 1 — sign in & OAuth authorization (runner browser job)

- New synthetic single-run Job, systemKey `google-oauth-signin`, dispatched like the
  M365 device-code job (`dispatch-device-code-job.ts` pattern): synthetic `CaseRequest`
  carrying the auto-setup marker (reuse/extend the exclusion in
  `web/lib/cases/exclude-m365-autosetup.ts` so these cases stay out of `/cases`), with
  the operator-typed seed secret ID on `secretOverrides["google-super-admin"]`. The
  super-admin **password never touches the app**; the app reads only the seed secret's
  `Username` (the super-admin email, needed as `Impersonate` and as the verify subject).
- OAuth: installed-app flow using the gcloud CLI's public client ID (its client secret
  is published; installed-app secrets are not confidential), scope
  `https://www.googleapis.com/auth/cloud-platform`, loopback redirect URI. The app
  generates a **PKCE verifier/challenge pair**; the challenge rides the job payload, the
  verifier never leaves the app. Playwright signs in (username → password → TOTP, minted
  via the existing OTP brokering), approves consent, and captures the `code` from the
  loopback redirect URL (navigation-capture; no listener needed — the redirect target
  never has to load).
- The job result carries the authorization code. It is single-use, ~10-minute expiry,
  and useless without the app-held PKCE verifier, so persisting it in the Job row is
  acceptable.
- Google login automation gets the same hidden-element discipline as the MS login
  (the `isVisible()`-lies lesson from PR #101): assert the *active* input, detect the
  "password typed but no error and no navigation" stall.

### Stage 2 — provision (app-side, `web/lib/secrets/provision-google-workspace.ts`)

All calls with the exchanged access token, all find-or-create/idempotent:

1. **Project**: deterministic `projectId` = `ctg-iam-{clientSlug}` (trimmed to Google's
   6–30 lowercase rule). `projects.get` first; on 403/404, `projects.create`. If
   creation without a parent is refused by org policy, look up the customer's
   organization (`organizations:search`) and retry with that parent.
2. **Enable APIs**: Service Usage `batchEnable` for `admin.googleapis.com` and
   `iam.googleapis.com`; poll the operation briefly for propagation.
3. **Service account**: find-or-create `iam-engine@{projectId}.iam.gserviceaccount.com`,
   displayName "iam-engine (Coretelligent IAM)". Record its `uniqueId` (the numeric
   client ID the delegation grant needs) and `email`.
4. **Key**: M365 `CredState` semantics — issue a new JSON key only when nothing valid is
   vaulted or `forceRotate` is set; otherwise `kept-valid`. New keys come back as
   `privateKeyData` (base64 JSON); held in memory only, never logged, never persisted
   outside Delinea. On rotate, delete the previously-issued key **only after** the new
   one is vaulted and verified (bounded cleanup; never touch keys we didn't issue).

### Stage 3 — delegation grant (runner browser job `google-dwd-grant`)

- Second sign-in (fresh OTP mint), then admin.google.com → Security → API controls →
  Domain-wide delegation. Payload (non-secret): the SA numeric client ID + scope list.
- Scopes granted (all four; the runner already requests subsets with graceful fallback):
  `admin.directory.user`, `admin.directory.group`, `admin.directory.orgunit`,
  `admin.directory.user.security`.
- Idempotent: find an existing row for the client ID first; add or update scopes only if
  needed; read back to confirm.
- **Manual fallback is first-class**: if this job fails or times out, the modal shows an
  "action needed" card with the exact client ID and comma-joined scope string (both
  copyable) plus admin-console instructions, and a "Verify again" button that re-runs
  stages 4–6. The one fragile step degrades to a 30-second paste, never a dead end.

### Stage 4 — verify (app-side)

Sign the SA JWT (`iss` = SA email, `sub` = super-admin email, directory scopes),
exchange at `oauth2.googleapis.com/token`, `GET /admin/directory/v1/users?maxResults=1`.
Delegation propagation can lag: retry ~8×15 s (the `probeWithPropagationRetry` pattern);
if still failing, finish as **unverified** with a "Re-check" button rather than erroring
— the credential may simply need a few more minutes.

### Stage 5 — vault & wire (app-side, `web/lib/secrets/write-google-workspace.ts`)

Delinea mapping (Evan's decision — reuse the existing **Automation - API** template):

| Template field | Value |
|---|---|
| Secret name | `Google API - IAM Engine` |
| ClientID | Google customer ID (`my_customer` resolved to the real ID when available) |
| ClientSecret | Service-account private key, **base64-encoded** (single line — a multi-line PEM does not survive Delinea fields; the vaulted value is the base64 of the full JSON key file) |
| accountid | Service-account client email (`iam-engine@{projectId}.iam.gserviceaccount.com`) |
| apiURL | Impersonate address (the super-admin email from the seed secret's Username) |

- Registered via the existing env-driven mechanism: `DEFAULT_TEMPLATE_NAMES["google-admin"]
  = "Automation - API"` with the field map above (overridable via `DELINEA_TEMPLATE_MAP`).
- **Fallback (Evan-approved)**: if the Automation - API template rejects the write in
  live testing (most likely: ClientSecret length limit vs the ~3 KB key), create a
  dedicated "Google Service Account" template in Secret Server with adequate field
  sizes and point the env mapping at it. The code doesn't change — only the
  template/field-map config.
- Write path mirrors `write-m365-app.ts`: verify-before-vault (stage 4 result gates the
  write), `delineaWriteConfigured` gate, create into the client's **Identity Services**
  subfolder or `updateSecretFields` in place when a real vaulted ID exists,
  stranded-credential detection with one bounded re-issue, manual-create fallback modal
  on Delinea write failure.
- Wire: `upsertSecrets(clientId, [{ name: "google-admin", externalId, label:
  "Google service account (auto)" }])` — the Secrets panel shows the "(auto)" label via
  the existing `deriveSecretRows`/`autoLabel` mechanism; self-learn `delineaFolderId`.

### Stage 6 — connection test

On `done`, auto-trigger `requestConnectionTests(slug, "google-workspace", "google-setup")`
and poll/surface the verdict in the modal (the runner-side probe already exists and
reports per-scope rights rows). This is the user-facing "make sure it was working right".

## Components

**Web (new):**
- `web/app/clients/_components/google-setup-button.tsx` — modal cloned from
  `m365-setup-button.tsx`: form phase (seed secret ID, forceRotate) → progress phase
  (5-step tracker: Sign in to Google → Create the service account → Grant domain-wide
  delegation → Save the credential to Delinea → Test the connection), 3 s polling,
  collapsible run log, re-run, manual-DWD and manual-Delinea fallback cards.
  Menu item in `client-actions-menu.tsx`, shown for clients with a `google-workspace`
  system.
- `web/app/api/clients/[slug]/google-setup/route.ts` — POST (start; gated on
  `client.edit_secrets` + client scope; audits `google.setup.start`; 409 on a live run)
  and GET (poll latest run state; on done, include the wired externalId + conn-test
  verdict).
- `web/lib/secrets/google-setup-run.ts` — run lifecycle: `GoogleSetupRun` /
  `GoogleSetupRunClient` Prisma models (cloned shape from the M365 pair: scope
  uniqueness via partial index, persisted `stage`/`log`/`error`/`warnings`, 3 h
  staleness reap), detached execution.
- `web/lib/secrets/setup-google-client.ts` — pure/DI core `setupGoogleForClient`
  orchestrating stages 1–6; every dep behind `callDep`; terminal `done`/`error`;
  result carries `serviceAccountEmail`, `clientId` (numeric), `externalId`,
  `verified`, `userActionNeeded` (manual DWD card data), `actions[]`.
- `web/lib/secrets/provision-google-workspace.ts` — stage 2 REST module (+ PKCE
  helpers and the code→token exchange).
- `web/lib/secrets/write-google-workspace.ts` — stage 5.
- `web/lib/secrets/dispatch-google-browser-job.ts` — both browser-job dispatches.
- Registry entries: `field-requirements.ts` gets `google-admin` (required: ClientSecret
  [base64 key] + accountid, or the legacy ServiceAccountKeyBase64/ClientEmail+PrivateKey
  shapes; apiURL/Impersonate); `delinea-templates.ts` gets the Automation - API default;
  `value-probe.ts` gets a blocking `google-admin` probe (decode key, sign JWT, one
  Directory read) so guided setup's test-before-write covers Google too.
- Migration: two new tables only.

**Runner (minor bump, 1.79.0):**
- Two browser flows: `google-oauth-signin` (sign-in + consent + code capture) and
  `google-dwd-grant` (delegation add/update/confirm), registered as claimable
  single-run job kinds like the Entra device-code flow.
- `Use-CtgGoogleSecret`: accept the **Automation - API field names** — `ClientSecret`
  (base64-decode when the value doesn't start with `-----BEGIN`; accept both a full
  JSON key and a bare PEM inside the base64), `accountid` → client email, `apiURL` →
  Impersonate, `ClientID` → CustomerId — alongside the existing shapes.
- `docs/modules/google-workspace.md`: document the Automation - API credential shape as
  the canonical vaulted form (per Evan: "update the instructions for the module to
  match this").

## Error handling

- Every collaborator call `callDep`-wrapped; failures set a terminal stage + surfaced
  error, never crash the run.
- Browser-job soft failures surface as WARN lines in the run log (`extractWarnings`
  pattern).
- DWD grant failure → manual fallback card (see stage 3). Delinea write failure →
  manual-create fallback modal (M365 pattern). Verify timeout → `unverified` + Re-check.
- One live run per client scope; stale runs reaped at 3 h; "Re-run setup" always
  available and safe (everything is find-or-create; keys only rotate on `forceRotate`
  or stranded recovery).

## Security notes

- Seed password/OTP: runner-side only, brokered per existing credential push-down.
- Authorization code: PKCE-bound; verifier held in app memory for the run only.
- SA private key: app memory → Delinea; never in Job rows, logs, or the DB.
- OAuth client: gcloud's public installed-app client; no secret of ours involved.
- Destructive edge: old SA keys are deleted only when this feature issued the
  replacement and it verified (stage 2, key cleanup rule).

## Testing

1. Unit (vitest, DI mocks, same style as `setup-m365-client` tests): core stage
   ordering/short-circuits, provisioning find-or-create + org-parent fallback + key
   CredState logic, write path (template map, base64, stranded, update-vs-create),
   PKCE helpers, value probe.
2. Runner Pester: `Use-CtgGoogleSecret` new field shapes (base64 JSON / base64 PEM /
   legacy), scope-string builder for the DWD payload.
3. Live e2e on **Drive Capital** with seed 8404 (web-dev-verify-recipe): full run,
   confirm the Delinea secret, the "(auto)" wiring, and a green conn test. This is the
   acceptance gate before touching the second Google client (Brighton Park).

## Out of scope

- JAMF (8404 is also the JAMF login; that system isn't touched).
- Fleet-wide sweep route (only two Google clients exist; per-client only).
- Any change to the M365 setup flow, its tables, or a generalized provider registry.
- Google-side offboard/onboard behavior changes (the executor already exists).
