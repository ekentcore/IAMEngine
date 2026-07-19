# Automated M365 setup — Phase 4/5 (per-client orchestration + fleet run + UI) design spec

**Date:** 2026-07-19
**Status:** Design for a live-validated follow-up build. Phase 4/5 of the automated-M365-setup program
(Phase 1 = Graph provisioning core, Phase 2 = device-code GA auth + browser flow, Phase 3 = Delinea
writeback — all shipped on this branch, PR #126). This spec's testable core (E4's `setupM365ForClient`)
ships alongside this doc; everything else here (the run-wrapper table, the real `dispatchDeviceCodeJob`,
the UI) is **not built yet** — it needs a real tenant + a TOTP-enabled GA account + a live browser to
validate, which isn't available in this environment.

## Context

Phases 1–3 built three independently-testable pieces:
- `provisionM365App` (Graph: find-or-create the `iam-engine` app registration, grant roles, issue creds)
- `startDeviceCode` / `pollDeviceCodeToken` (Entra: device-code auth for a delegated GA Graph token) +
  the `entra-devicecode` browser flow (runner: drives the GA through `microsoft.com/devicelogin`)
- `writeProvisionedM365App` (Delinea: validate-then-vault the provisioned app's credential)

Nothing yet chains them into one per-client run, dispatches the real browser job, tracks progress across
a fleet sweep, or exposes a button. That's this phase.

## E4 — the shared orchestration core (built here)

`web/lib/secrets/setup-m365-client.ts` — `setupM365ForClient(input, deps): Promise<SetupResult>`. Pure
and side-effect-free: every collaborator that touches the network, a runner job, or the database is
injected via `deps` (`startDeviceCode`, `pollDeviceCodeToken`, `provisionM365App`,
`writeProvisionedM365App`, `hasGlobalAdminSecret`, `dispatchDeviceCodeJob`, `getJob`, `sleep`). This is
what makes the chain unit-testable with no real Entra/Delinea/db (`setup-m365-client.test.ts`, 10 cases).

Staged flow, one `SetupResult.stage` per exit point:

1. `no-ga-secret` — `hasGlobalAdminSecret(client.id)` is false. Fail fast: no device code is minted, no
   browser job is dispatched (a code would just expire unused).
2. `device-code-init` — `startDeviceCode(tenant)` failed (bad tenant, Entra unreachable).
3. `browser-signin` / `token` — `pollDeviceCodeToken(...)` failed. The runner's
   `Invoke-CtgEntraDeviceCode` always reports the browser job `Status='ok'` even when the sign-in itself
   failed (MFA push/SMS not automatable, bad creds, GA login rejected) — that failure only shows up as a
   `WARN ...` line buried in the job's recorded result. So the token poll is the primary signal; on
   failure the core does one `getJob(jobId)` and runs `extractWarnings()` (a small depth-bounded walk for
   any string containing `WARN`) over the result. Warnings found → `stage:"browser-signin"` (we know why);
   none found → `stage:"token"` (an OAuth-level failure — expired/declined/network — with no browser
   explanation). Either way `userCode`/`verificationUri` are surfaced on the result so an operator can
   finish the sign-in by hand if needed.
4. `provision` — `provisionM365App({ graphToken, tenantId: tenant, caps })` failed (e.g. a required Graph
   role missing from the tenant).
5. `write` — `writeProvisionedM365App({ client, provision: result })` returned `ok:false` (secret failed
   its live Entra probe, or Delinea write isn't configured for this client).
6. `done` — `{ ok:true, appId, wroteCreds, verified, gaps }` from the provision/write results.

Never logs or returns a token, client secret, or certificate value — `actions[]` carries step names and
ids only; a dedicated test (`"never leaks..."`) asserts none of the mocked secret values appear anywhere
in the JSON-serialized result or in any `actions[]` entry.

`SetupDeps.dispatchDeviceCodeJob` and `.getJob` are the only two deps this core does NOT define a real
implementation for in this PR — see Component C below for their live impl.

## Non-goals of this doc (still design-only; do not build without a fresh live-validation pass)

- The run-wrapper table + detached run loop (Component B)
- The real `dispatchDeviceCodeJob` (Component C)
- The status-poll route + UI (Component D)
- The E5 fleet sweep semantics (Component E)

## Component B — the run-wrapper (live-validated; NOT built)

Mirrors `web/lib/audits/audit-runs.ts`'s `startRun`/`isStale`/`latestRun` shape, adapted for a run that is
per-client and mutating (not a single read-only sweep with one findings blob).

**New table** `M365SetupRun` (one row per triggered run, single-client or fleet):
```
id, mode ("single"|"fleet"), status ("running"|"done"|"failed"), startedAt, finishedAt,
startedBy (actor label snapshot), scanned Int @default(0), total Int @default(0), error String?
```
**New table** `M365SetupRunClient` (one row per client visited by a run — this is what the UI polls for
per-client progress, unlike `FleetAudit` which only has one aggregate `findings` blob):
```
id, runId (FK -> M365SetupRun), clientId, status ("pending"|"running"|"skipped"|"ok"|"failed"),
stage String?, error String?, browserWarnings Json?, userCode String?, appId String?,
wroteCreds Boolean?, verified Boolean?, startedAt DateTime?, finishedAt DateTime?
@@index([runId])
```
Reusing `FleetAudit`/`AppSetting` was considered and rejected: `FleetAudit.findings` is one JSON blob
written at the very end of a read-only sweep, but this run is mutating and needs a durable per-client
row *while a client is still in flight* — if the process restarts mid-fleet-run, a re-run must be able to
tell "which clients already got a valid app registration" from `M365SetupRunClient` rows, not silently
re-provision (provisioning IS idempotent — `provisionM365App` finds-before-creates — but re-running 40
clients' worth of device-code sign-ins because of a crash 5 clients in is still a real cost).

`startRun(db, mode, clientIds, startedBy, deps)`:
- Refuse if a `running` run of the same mode exists and isn't stale (mirror `isStale`/`STALE_AFTER_MS`).
- **Stale-after must be much larger than audit's 30 min**: `pollDeviceCodeToken` alone can block up to
  `expiresIn` (~15 min) per client, sequentially, for a fleet run. Recommend `STALE_AFTER_MS` scaled to
  the batch (`clientIds.length * 20min`, floor 30 min) rather than one fixed constant — a fixed 30-min
  stale-after would falsely mark a legitimately-still-running 10-client sweep as crashed.
- Create the `M365SetupRun` row (`total = clientIds.length`) + one `M365SetupRunClient` row per client,
  `status:"pending"`. Detach (`detach(fn)`, same seam as `audit-runs.ts`, swappable in tests).
- The detached loop processes clients **sequentially, not in parallel** — device-code sign-in is a live,
  interactive browser flow; running several at once means several simultaneous
  `microsoft.com/devicelogin` tabs on the same runner, which the existing browser-flow claim model isn't
  built for (one in-flight browser job per agent). For each client: mark its row `running`, call
  `setupM365ForClient`, write the full `SetupResult` back onto the row (`status` from `result.ok ?
  "ok":"failed"`, `stage`, `error`, `browserWarnings`, `appId`, `wroteCreds`, `verified`), bump
  `M365SetupRun.scanned`. Wrap each client in try/catch so one client's thrown error doesn't abort the
  rest of the batch — record it as `failed` on that client's row and continue (mirrors `audit-runs.ts`'s
  per-run try/catch, just moved inside the loop).
- On loop completion mark `M365SetupRun.status:"done"`; an uncaught error around the loop itself (not a
  per-client one) marks it `"failed"` with `error`, same as `audit-runs.ts`.

`GET` status route: return the run + its per-client rows (id/status/stage/appId/wroteCreds/verified —
**never** `browserWarnings`' raw content if it could echo anything sensitive, though in practice WARN
lines are operator-facing text only, no secret values ever reach that path per E4's leak test).

## Component C — the real `dispatchDeviceCodeJob` (live-validated; NOT built)

Mirrors `force-spanning-sync/route.ts`'s dispatch shape, but this core has no existing case to ride —
per the locked design decision, it creates a **minimal synthetic `CaseRequest`** to host the one
`entra-devicecode` job:

```ts
async function dispatchDeviceCodeJob(db, client, userCode): Promise<{ jobId: string }> {
  const caseRequest = await db.caseRequest.create({
    data: {
      action: "onboard",          // the runner's $DISPATCH['entra-devicecode'] only has Onboard/Offboard
      createdSource: "api",       // lanes wired — never change this to a new action
      clientId: client.id,
      payload: { m365AutoSetup: true },
      status: "in_progress",      // whatever CaseRequest requires as a non-"planned" starting status
    },
  });
  const job = await db.job.create({
    data: {
      caseRequestId: caseRequest.id,
      systemKey: ENTRA_DEVICECODE_KEY,   // "entra-devicecode" — already registered in adhoc.ts + capabilities.ts
      mode: "api",
      sequence: 1,
      status: "pending",
      singleRun: true,
      request: {
        secretNames: ["m365-global-admin"],
        config: { userCode },
        dependsOn: [],
        requiresApproval: false,
        captureEvidence: false,
      },
    },
  });
  return { jobId: job.id };
}
```

Open questions to resolve during live validation (not blocking the design, but flag explicitly):
- Whether the synthetic `CaseRequest` needs a `status` that keeps it out of the normal case list/queue UI
  (it's not a real onboarding case — it should not show up next to genuine cases). Likely a
  `createdSource:"api"` + a dedicated filter, consistent with how other adhoc/system jobs are excluded
  today (`force-spanning-sync`'s job rides an *existing* case, so this is new territory — check
  `docs/DATA_MODEL.md` / the cases list query for how `createdSource` is already filtered, if at all).
- Whether the synthetic case ever needs to be resolved/closed, or can stay `in_progress` forever once its
  one job finishes (harmless clutter vs. a required terminal state some other sweep expects).

`getJob(jobId)` is a thin `db.job.findUnique({ where: { id }, select: { status, result, error } })`.

## Component D — the UI (live-validated; NOT built)

**Per-client** (client detail page): a "Set up M365 automatically" button, gated `client.edit_secrets`
at minimum (see Component E for why the *fleet* trigger needs more). Click → `POST` a single-client
`M365SetupRun` → poll its one `M365SetupRunClient` row. While running: show the device `userCode` +
`verificationUri` prominently (the operator/GA may need to actually complete the sign-in) and a
provision → write → verify progress line sourced from `stage`. On failure: surface `error` and, if
present, each `browserWarnings` line verbatim (these are the human-readable "why" — e.g. "MFA push not
automatable", "GA login rejected"). On success: appId + verified + any `gaps` (optional Graph roles the
tenant didn't have — informational, not blocking).

**Fleet** (reuses the `/fleet-audit` run UI pattern — `scan-button.tsx` + the poll loop already built for
`AuditRun`, adapted for `M365SetupRun`'s per-client rows instead of one `findings` blob): a table of
target clients with a live status column, a start button, and the same "already running, here's whose"
409 semantics as `POST /api/fleet-audit/[kind]`.

## E5 — fleet sweep semantics (live-validated; NOT built)

- **Target selection / per-client skip**: before starting, resolve the candidate client list and mark
  clients `skipped` up front (never dispatch a device code for them) when:
  - No `m365-global-admin` Delinea secret wired (mirrors E4's `no-ga-secret` stage — do this resolution
    in the run-wrapper too, so the UI shows "skipped: no GA secret" instead of burning a slot as
    "running" then "failed").
  - The client's GA secret is known (from a prior attempt or a wiring-time check) to be MFA push/SMS —
    not automatable, per Phase 2's hard-stop. Needs a place to record this fact against the secret/client
    so repeat sweeps don't keep re-attempting a doomed sign-in; simplest: read the `browserWarnings` from
    the client's last `M365SetupRunClient` row and skip if it contains an MFA-push/SMS WARN, with a
    manual "retry anyway" override.
- **Dry-run**: an explicit `dryRun` flag on the fleet trigger that resolves targets + secret checks (so
  the operator sees exactly who would run and who'd be skipped and why) without dispatching any device
  code or browser job. Mirrors the case-level `dryRun` gate already used for the Spanning force-sync's
  live-portal login (`src.case.dryRun` in `force-spanning-sync/route.ts`) — same reasoning: there is no
  `-WhatIf` for a real device-code sign-in, so dry-run must short-circuit before dispatch, not after.
- **Permission gate**: `client.edit_secrets` is fine for triggering it against *one* client (same gate the
  manual create-secret route uses) but a **fleet** run is a bulk MUTATING sweep across every client with a
  GA secret — closer in blast radius to `agent.manage`/`case.approve_destructive` than to a read-only
  audit's `client.edit_secrets`. Gate the fleet POST at `ops_manager` (or above) specifically, leaving
  single-client at `client.edit_secrets`, and audit-log both (`recordAudit`/`auditActor`, same as
  `force-spanning-sync` and the fleet-audit route).
- **Batch size**: given the sequential ~15-min-worst-case-per-client bound, consider capping a single
  fleet run to a configurable batch (e.g. clients with a GA secret, N at a time) rather than always firing
  the whole fleet — a ~40-client batch could legitimately run for several hours if many device codes time
  out. Flag as an open call for the live-validation pass, not resolved here.

## Explicit: live-validation requirement

None of Components B–D (the run-wrapper, the real dispatch, the UI) should ship without an operator
running the **entire chain live**: a real tenant, a real Global Admin account with **TOTP** enabled on
its Delinea secret (push/SMS GA accounts hard-stop at the browser flow per Phase 2), and a real browser
completing `microsoft.com/devicelogin`. E4's core is unit-tested with every network/db boundary mocked —
that proves the *chaining logic* (stage transitions, WARN surfacing, no-secret-leak) is correct, not that
Entra's device-code endpoint, the runner's `entra-devicecode` flow, or Delinea's write path behave as
assumed under real conditions. Phase 2's spec already flagged the browser leg itself as needing this same
live pass; Phase 4/5 adds "the full multi-minute chained run, including a fleet batch" to what must be
watched end-to-end before this is exposed to real operators as a self-serve button.

## Deploy artifacts (once B–D are built)

- Migration: `M365SetupRun` + `M365SetupRunClient` tables.
- No runner change expected (Components B–D are web-only — the `entra-devicecode` runner flow and its
  wiring already shipped in Phase 2/3).
