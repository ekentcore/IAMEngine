# Fleet Setup — M365 (design)

Date: 2026-07-22

## Goal

A `/tools` page that lets an operator see, in one table, the M365 credential health of
every client that has an `m365`, `entra`, or `exchange` system — and fix each one in place:

- **Correct Permissions** when the app registration exists but is missing Graph permissions
  (keep the existing secret, reconcile/consent the gaps).
- **Set up M365** when no credential is wired, or the credential can't connect at all
  (run the existing auto-setup workflow, asking for the Global-Admin Delinea number with
  suggestions).
- Work through the setup flow **even for an already-configured client** — today the shared
  modal jumps straight to the success screen and won't let you adjust permissions.

Volume-weighted context: ~130+ clients have an M365-family system; this is the fleet-wide
companion to the per-client `ConnectionTestPanel` + `M365SetupButton`.

## What already exists (reused, not rebuilt)

- **Connection test lane** — `ConnectionTest` table, `requestConnectionTests(slug, systemKey?)`
  and `listAllConnectionTests()` in `lib/jobs/runner-service.ts`, pure helpers in
  `lib/jobs/conn-test-logic.ts` (`testableSystems`, `parseRights`, `summarizeRights`).
  The runner probe reports per-capability rights rows where `op` **is the capability's `need`
  string** (verified in `runner/Start-IamRunner.ps1:2500-2512`), matching `GRAPH_*_CAPS` in
  `lib/secrets/graph-caps.ts` exactly — so a missing optional rights row maps back to its cap
  (and its `suggestedRole`) by an exact `op === need` match.
- **M365 auto-setup** — `M365SetupButton` modal, `setupM365ForClient`, the per-client route
  `POST/GET/DELETE /api/clients/[slug]/m365-setup` (requires `body.gaSecretRef`), and
  `provisionM365App`, which already **find-or-reuses** the app by its `ctg:iam-engine` tag,
  reconciles `requiredResourceAccess`, admin-consents missing roles by capability, and
  **keeps a still-valid secret** unless `forceRotate` (`credState = "kept-valid"`, writes
  nothing). This is exactly the "correct permissions, leave the secret" behavior.
- **`DelineaSuggestions`** — ranked GA-login secret suggestions for the setup form.
- **Run orchestration pattern** — `startM365SetupRun` / `latestM365SetupRun` /
  `cancelM365SetupRun` (`lib/secrets/m365-setup-run.ts`) with a one-running-per-scope partial
  unique index. The fleet test run mirrors this shape.

## Architecture

New page `web/app/tools/fleet-m365`. A durable server-side **fleet test run** orchestrates the
tests; the page polls a roll-up. Both row actions reuse `M365SetupButton`.

Flow:
1. Page (server) renders in-scope M365 clients as one row each, from last-known `ConnectionTest`
   state, then the client component auto-starts a fleet test run.
2. `POST /api/tools/fleet-m365` creates a `FleetM365TestRun` (guarded: one running per scope
   `fleet-m365`) and queues a connection test for **each M365-family system of each in-scope
   client** via the existing `requestConnectionTests(slug, systemKey)` (never `deep` — no
   interactive sign-in fans out across the fleet). The runner throttles execution via its claim
   batches, so no app-side concurrency batching is needed.
3. The page polls `GET /api/tools/fleet-m365` every 3s. GET both **advances** the run (marks it
   `done` once no target M365 test is still `pending`/`running`) and returns the roll-up.
   Orchestration piggybacks on the poll — consistent with the app's "read state at query time,
   not a heartbeat sweep" pattern. The run + the `ConnectionTest` rows are durable, so a reload
   rejoins a sweep in progress.
4. Each row derives a **state** + **suggested action**; the action opens `M365SetupButton`
   preconfigured.

### Refinement from the approved design

The approved sketch had a `FleetM365TestTarget` child table tracking per-target queue state and
app-side concurrency batching. Since `ConnectionTest` rows are already the durable per-client
state and the runner is the real throttle, we keep only the `FleetM365TestRun` sweep record and
**derive** per-client state from `ConnectionTest`. This avoids duplicating conn-test state (which
could drift) while preserving the intent: server-side, durable, resumable, one-run-per-scope.

## Data model (one additive migration)

```
model FleetM365TestRun {
  id         String   @id @default(cuid())
  scope      String   // "fleet-m365" (future-proofed for a scoped variant)
  status     String   @default("running") // running | done | cancelled
  startedAt  DateTime @default(now())
  finishedAt DateTime?
  startedBy  String?  // actor label snapshot
  total      Int      @default(0) // client×system tests queued
  clients    Int      @default(0) // distinct clients swept
  @@index([scope, startedAt])
}
```

Plus a migration-only partial unique index `FleetM365TestRun_one_running_per_scope` on
`(scope) WHERE status = 'running'` (mirrors `M365SetupRun_one_running_per_scope`).

## Backend

`web/lib/jobs/fleet-m365-test.ts` — deps-injected, with `fleet-m365-test.test.ts`:

- `M365_FAMILY = ["m365", "entra", "exchange"]`.
- **Pure** `classifyM365Client(input) → { status, tags[], suggestedAction, missingOptionalRoles[] }`
  from `{ hasAdminSecret, testableSystemKeys[], tests[] }`:
  - `status`: worst-of the M365 tests — `fail` > `running`/`pending` > `unverified` > `ok`, or
    `untested` when none exist.
  - tags (a client can carry several): `no_creds` (no `m365-admin` secret / no testable M365
    system), `missing_perms` (`summarizeRights.state === "missing"` on any test),
    `over_permissioned` (`surplus > 0` on any test), `connection_failed` (a test failed on
    access/API, not on rights), `completed` (all `ok`/verified, no gaps), `untested`.
  - `suggestedAction`: `setup` for `no_creds` / `connection_failed`; else `correct` for
    `missing_perms` / `over_permissioned`; else `none` (the modal is still reachable to adjust).
  - `missingOptionalRoles`: for rights rows with `optional && ok === false`, match `op` to a
    `GRAPH_OPTIONAL_CAPS.need` and collect its `suggestedRole` — the set to pre-check in the
    modal (required gaps are always granted by provision, so they need no pre-check).
- **I/O** `startFleetM365Test(db, { startedBy, access })` — guard live run; resolve in-scope,
  non-archived clients with an M365-family system (`scopeAllows`); queue each testable M365
  system's connection test; create the run. Returns `{ started, id }` or `{ started:false, reason }`.
- **I/O** `rollupFleetM365Test(db, { access })` — latest run + per-client rows (fetch
  `ConnectionTest` for target clients' M365 systems + `m365-admin` secret presence, classify).
  Settles a `running` run to `done` when no target test is unsettled.
- **I/O** `cancelFleetM365Test(db)` — flip the run to `cancelled` and delete still-`pending`
  M365 `ConnectionTest` rows so the runner stops claiming them (running ones finish naturally).

`web/app/api/tools/fleet-m365/route.ts` — `POST` start, `GET` (advance + roll-up), `DELETE`
cancel. Each: `guard("client.edit_secrets")` + `fleetWideAccess(db, user.id)`, scope-filtered.

## Frontend

- `web/app/tools/fleet-m365/page.tsx` (server) — auth gate (`client.edit_secrets` +
  fleet-wide), initial roll-up.
- `_components/fleet-m365-table.tsx` (client) — mirrors the clients-v2 explorer house style:
  - **Filter bar** (`.filters`): no-debounce search over a precomputed per-row haystack
    (name, CORE id, domain), plus a count-annotated **state multiselect** (`missing_perms`,
    `no_creds`, `over_permissioned`, `completed`, `connection_failed`, `untested`) echoing
    selections as `.badge` chips — the `ModulePicker` pattern. Local React state.
  - **Table** (one row per client): name/CORE id, overall status badge, per-system rights
    summary (reusing `summarizeRights`), expandable per-system rights detail (same rendering as
    `ConnectionTestPanel`), and an action button (`Correct Permissions` / `Set up M365` /
    `Adjust`). `Retest all` + per-row `Test`.
  - Actions open a single embedded `M365SetupButton` (`hideTrigger`, opened via an incrementing
    `openSignal`) targeted at the row's slug, with `presetForceRotate={false}` and
    `presetOptionalRoles={row.missingOptionalRoles}` for the correct-permissions case.
- **`M365SetupButton` changes** (shared — applies to the per-client Setup page too):
  1. **Global success-box fix**: `openForm()` lands on the **form** for a terminal (`done` /
     `failed` / `cancelled`) last run, showing an "already configured — last run <status>"
     banner with the finished details still reachable; it only jumps to `progress` for a live
     (`running` / `pending`) run.
  2. New optional props `presetForceRotate?`, `presetOptionalRoles?: string[]`, `slug` target
     override via `openSignal` — applied on open when provided; undefined keeps today's defaults
     (all optional caps on, `forceRotate` off).
- **Nav**: add `["/tools/fleet-m365", "Fleet setup — M365"]` to the Tools group in
  `app/_components/nav.tsx` and `app/_components/mobile-nav.tsx`.

## Error handling

- Out-of-scope / restricted clients are filtered server-side (`scopeAllows`); never queued,
  never shown.
- A concurrent sweep is rejected by the one-running-per-scope guard (409 → the page shows the
  in-progress run).
- Per-client queue failures are best-effort and don't abort the sweep.
- `deep` is never set on a fleet-queued test (no interactive M365 sign-in fans out).
- Clients with an M365 system but no wired `m365-admin` secret aren't testable → surfaced as
  `no_creds` with a `Set up M365` action rather than a phantom failing row.

## Testing

- `conn-test-logic` / `graph-caps` stay the source of truth (already tested).
- New `fleet-m365-test.test.ts`: `classifyM365Client` across each tag/action, worst-of status,
  `missingOptionalRoles` mapping (exact `op === need`), and the empty/untested cases.
- Existing web test suite + typecheck/build must stay green.

## Out of scope

- No new fleet-wide *provisioning* endpoint — corrections reuse the per-client
  `/api/clients/[slug]/m365-setup`. (Fleet-wide provisioning already exists at `/api/m365-setup`
  and is separate.)
- No runner changes (web-only; the conn-test probe and provision paths are unchanged).
