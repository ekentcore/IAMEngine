# Guided-setup test feedback → "Test connections" parity

## Problem

The live tests in guided credential setup (`/clients/[slug]/setup`) give almost no
feedback: during a run you can't see what's being tested, and per-system success/failure
is muted. The complaint: it should look like the **Test connections** button on the
client detail page (`ConnectionTestPanel`), which shows a rich per-system staged table
(Fields → Can access → API works → Rights) with live status and per-operation detail.

Three test surfaces exist in guided setup, all to be brought to parity:
1. **Field-shape test** (`POST /secrets/test`) — app-side "reads ok" check per step.
2. **Live connection test** (`POST`/`GET /conn-test`) — real runner read; today only a
   client-wide "X of Y verified" counter + a read-only per-step verdict.
3. **Automatic (browser) run** (`GuidedApiSetup`) — 4-stage checklist that never advances
   because the runner's stage plumbing is dead.

## Approach: per-step staged badges, full parity, across all three surfaces

### Phase 1 — Extract the shared staged-badge + rights renderer (web-only, inert)

The badge helpers (`fieldsBadge`/`accessBadge`/`apiBadge`/`rightsBadge`) and the
expandable per-operation rights sub-table currently live inside
`web/app/clients/_components/connection-test-panel.tsx`. Lift them into a shared module
`web/lib/jobs/conn-test-badges.tsx`:

- `type ConnTest` — the shared Test shape (systemKey, status, detail, accessOk,
  accessDetail, fieldsOk, fieldsDetail, rights, onPrem, finishedAt, credExpiresAt).
- `<ConnStages test={t} />` — renders the four stage badges (as `<td>`-free inline spans
  so a caller can place them in a table or a flex row).
- `<RightsDetail rows={t.rights} />` — the per-operation sub-table (missing / optional /
  surplus / escalation rows).
- Keep the badge functions exported for unit assertion.

`ConnectionTestPanel` consumes the shared renderer with no visible change. Badge-output
unit tests lock the strings/colors before and after.

### Phase 2 — Per-step live connection test in the wizard (web-only)

In `setup-wizard.tsx` `StepCard`, replace the read-only "Live connection" block with the
shared `<ConnStages>` scoped to the step's system(s):

- Show **Fields → Can access → API works → Rights** per system, colored badges +
  tooltips + the expandable rights table — identical to the panel. The field-shape test
  (surface 1) renders as the **Fields** stage of this strip, unifying the two badges into
  one coherent status line.
- Add a per-step **"Test this connection"** button that POSTs `{ systemKey, deep: true }`
  once per system in the step (mirrors the panel's per-row Retest, including `deep` for
  the interactive probe). The client-wide "Run live connection tests" stays up top.
- Widen `loadConn()` to capture the full `ConnTest` shape (today it reads only 4 fields),
  store it in `conn` state, and generalize the poll to run whenever **any** system is
  pending/running (not only after the client-wide button), bounded by the existing
  `CONN_POLL_DEADLINE_MS` (120s).

Decision on record: `deep: true` per step can fire a real vendor sign-in for that one
system — same as the panel's Retest today. Accepted for parity.

### Phase 3 — Real stage progress for the Automatic (browser) run (runner + web + migration)

Close the existing-but-dead stage loop (three gaps):

1. **Flow** `runner/browser/flows/mimecast-console-signin.mjs`: call the already-injected
   `reportStage("signin" | "create" | "harvest")` at each boundary.
2. **Runner** `Coretelligent.Browser` → `Invoke-CtgBrowserFlow`: drain the sidecar's
   stderr **line-by-line during execution** (not `ReadToEndAsync()` after exit), match
   `@@stage:<name>` markers, and forward each via the existing `Send-CtgProgress` →
   `POST /api/jobs/:id/progress`. Runner version bump + deploy. (stderr tail behaviour for
   error reporting is preserved by accumulating drained lines.)
3. **Shape reconciliation**: add a dedicated `Job.stage String?` column (sibling to
   `progressAt`). The progress endpoint accepts an optional `stage`; `recordProgress`
   sets it when present, WITHOUT appending to the free-text `progress` narration trail.
   `create-api-app` GET returns `job.stage`, so `GuidedApiSetup`'s `RUN_STAGES` checklist
   advances live (`⏳ Creating the API application` → `✓`) instead of "working…".

Chosen the scalar column over cramming into the capped-at-20 `progress` array: the array
is human-facing run-report narration; a scalar `stage` keeps the concerns separate and
matches what the GET already tries to read.

## Out of scope

- Screenshot/run link on browser-run failure (the un-picked option).
- M365/Google setup buttons — they own their own long-run modals.

## Testing

- Phase 1: badge-output unit tests, identical before/after.
- Phase 2: wizard tests — per-step button POSTs the right bodies; poll settles; staged
  display renders each stage.
- Phase 3: Pester test for line-by-line `@@stage:` parsing in `Invoke-CtgBrowserFlow`;
  web test for the progress endpoint storing `stage` and the GET surfacing it.

Each phase is independently shippable (1 → 2 → 3), one PR.
