# Finalization push — shared seams & overnight sequencing

Date: 2026-07-22. Context: last hardening push before hosting migrates from the local
Mac (launchd, LAN IP) to Azure. Seven features, resilience-weighted. This doc pins the
**shared contracts** every feature spec must conform to, and the **collision-aware
schedule** for the overnight implementation subagents.

Feature specs (build-priority order chosen by Evan): #2 cutover, #7 drain, #3 health,
#6 readiness, #4 governor, #5 backup, #1 runner pool.

## Shared seams (authoritative — every spec conforms to these)

### S1 — the `claim()` dispatch-admission pipeline
`web/lib/jobs/runner-service.ts::claim()` is the ONE place a dispatch decision is made.
Today it runs: host/capability exclusion → dependency-DAG gate (`runner-logic.ts`
`isClaimable`/`dependencyGateOpen`) → secret preflight → setup-state gate → priority
standby (`shouldStandBy`) → atomic assignment (`updateMany where status:"pending"`).

We insert a new ordered **admission** stage BEFORE atomic assignment, in this order:
- (a) **maintenance / drain gate** — feature #7. If the target system/client is in
  maintenance, or the claiming agent is draining, that job is not admitted.
- (b) **global in-flight cap** — feature #4.
- (c) **per-tenant (`clientId`) in-flight cap** — feature #4.
- (d) **per-(`clientId`,`systemKey`) in-flight ≤ 1** — feature #4. REQUIRED to make the
  runner pool (#1) safe: same client+system never runs concurrently (session/rate
  collision, incident UM0029840).

Only features **#4 and #7** may modify `claim()`. #7 lands first (gate a); #4 layers
gates (b–d) after it. Every other feature READS job/agent state and never edits `claim()`.

> **RECONCILIATION (from #4's exploration): `Job` has NO `clientId` column** — client
> lives on `CaseRequest`. So every "per-tenant / per-client" count (#4's caps AND #3's
> board grouping) must either join through `CaseRequest` (a single raw aggregate; #4's
> chosen path) or denormalize a `Job.clientId`. #4 keys its caps by joining through
> `CaseRequest`; #3 does the same for its per-client rollup. If we later add
> `Job.clientId` (needed for #4's optional partial-unique-index backstop), it's one
> migration both features share.

> **RECONCILIATION: `claim()` race-safety mechanism (#4).** `updateMany WHERE
> status:"pending"` is atomic per-row but NOT across a group, so two agents can each
> flip a different pending job for the same `(clientId,systemKey)` (write skew under
> READ COMMITTED). #4 wraps the count→admit→assign critical section in a single
> fleet-wide `pg_advisory_xact_lock`. This serializes every claim fleet-wide, so with a
> runner pool (#1) the critical section MUST stay tight — fine at ~5s polls + small
> pools, but it is the #4×#1 coupling to watch under load.

### S2 — heartbeat directive channel + the heartbeat sweep fan-out
`/api/agents/heartbeat` response already carries `{restart, update, migrate}` (honored at
`Start-IamRunner.ps1:3229-3232`). We add `{drain: bool}` (#7) and reuse `{migrate}` (#2).
Runner honors `drain` by finishing the current job and then claiming nothing.

> **RECONCILIATION: `heartbeat()` in `runner-service.ts` is a MULTI-FEATURE touchpoint**
> beyond `claim()`. Three features edit it, all additively:
> - #7 adds the `drain` field to the heartbeat *response object*.
> - #3 hangs a `sweepFleetAlerts` call on the heartbeat *sweep fan-out* (~`:467-476`,
>   alongside SN-intake/conn-test/db-backup).
> - #5 hangs a `sweepRestoreDrill` call on that same fan-out (~`:476`).
> Integration order: land #7's response-field edit and #3/#5's sweep-line inserts as
> separate hunks — they don't overlap, but the integrator should expect all three in one
> function. (Note #7's open question: whether a global drain should also *pause* these
> sweeps. Default recommendation: leave them running — idempotent, no torn-case risk.)

### S3 — AppSetting keys (`claimAppSetting`) — one namespace per feature, no sharing
- #7 → `maintenance.*`
- #4 → `concurrency.*`
- #3 → `alerts.*` (EXTEND existing `failure_notifications`, don't fork — see S6)
- #5 → `backup.azure.*`

### S4 — runner-side serialized lane
`runner/Start-IamRunner.ps1`, `runner/VERSION`, `runner/lib/*` are a **serialized**
integration lane. #1 (new pool supervisor files + drain honoring), #7 (drain honoring),
and #2 (migrate — already exists) touch the runner. `runner/VERSION` bumps collide by
construction (see memory: repeated 1.9x collisions), so VERSION is bumped ONCE at
integration, not per-PR. Every runner-touching spec must list the exact files it edits.

### S5 — web pages are additive
New pages get their own route dirs and reuse the v2/v3 page-loader pattern
(`app/<page>/_lib/loader.ts`) + the host design system (flat, minimal borders, sentence
case, no gradients). Nav registration is one shared file — flag it as a merge touchpoint.

> **RECONCILIATION: `app/_components/nav.tsx` is touched by #3, #6, and #2** (one link
> each: `/health/fleet`, `/golive`, `/cutover`). One-line additive inserts; trivial
> conflict, resolve by keeping all three links. This is the only web file more than one
> feature edits apart from `runner-service.ts`.

### S7 — the #4 ⇄ #1 governor contract
Feature #1 (runner pool) borrows its ENTIRE parallel-safety story from #4. So #4 must
expose **two** things, not one:
1. the claim-time admission check (gates b–d), and
2. a **"governor active"** capability signal the pool can read at startup.

`Start-IamRunnerPool.ps1` MUST refuse `-PoolSize > 1` when the governor is absent/disabled
(otherwise two members can run the same tenant+system concurrently → UM0029840 across
processes). Ship #4 before enabling any pool with size > 1.

### S6 — chat alerting reuses `failure_notifications`
Feature #3 EXTENDS the existing failure-notification plumbing (PR #60 master switch;
Test bypasses the switch). It does not create a parallel alerting system. Backup (#5)
also delivers its drill-failure / missed-backup alerts through this same plumbing.

## Overnight execution schedule (collision-aware)

Spec-writing (now): all 7 are parallel-safe — distinct spec files.

Implementation (subagents, isolated worktrees):
- **Wave A — parallel, distinct files:** #3 (health board), #6 (readiness), #5 (backup).
  Mostly new pages + read-only queries + standalone scripts.
- **Wave B — serialized on `claim()`:** #7 (drain gate S1a) → then #4 (caps S1b–d).
  Same function; must not run in parallel worktrees.
- **Wave C — depends on B + A:** #2 (cutover) needs #7's drain + #3's health signal.
- **Runner lane (serialized on VERSION):** #1 pool + #7 drain-honoring + #2 migrate.
  One coordinated `runner/VERSION` bump at integration.

Build-priority order (#2,#7,#3,#6,#4,#5,#1) is Evan's ranking; the waves above are the
file-collision constraints. Reconcile at integration: land Wave A freely; gate B behind
its serialization; do the runner VERSION bump last.

## Decisions needed from Evan (consolidated from all 7 specs)

Each has a recommended default so implementation is NOT blocked if unanswered.

| # | Feature | Decision | Recommended default |
|---|---------|----------|---------------------|
| D1 | #2, #5 | **Does the Azure host have network egress to Delinea with a working broker account?** This is a hard infra fact, not a design choice — real operation (and the "secrets resolvable" checks) depend on it. | *Must verify before cutover.* Blocking for #2 blob-cutover and #5 Phase 2; NOT blocking for local Phase-1 work. |
| D2 | #5 | Azure Blob auth: managed-identity-only vs also ship a Delinea-brokered SAS path for the transition window. | Managed identity, **plus** a SAS fallback — the move is tomorrow and MI may not be wired yet. |
| D3 | #2 | Is the DB move `pg_dump`→`restore.sh` (baseline-in-dump verify holds) or DMS/replication? | Assume `pg_dump`→`restore.sh` (matches PR #26). |
| D4 | #7 | Should a global drain also pause the heartbeat DB sweeps (SN-intake/conn-test/backup) during the cutover window? | **No** — leave running; idempotent, no torn-case risk. |
| D5 | #6 | Can a *cached* M365 sweep back a GO verdict, or must the gate force a fresh Graph sign-in per client? | Cached backs GO (with age shown); "fresh sweep" is an explicit button (Conditional-Access burst risk). |
| D6 | #3 | Alert-dedupe state: AppSetting `alerts.state` JSON blob (no migration) vs a first-class `Agent.offlineAlertedAt` column. | AppSetting blob — zero migration, ships tonight. |
| D7 | #4 | Do the per-tenant / per-(client,system) caps key on the **parent** tenant for child accounts (shared Graph/EXO sessions)? And are ad-hoc/`singleRun` jobs governed? | Key on parent tenant; exempt ad-hoc/`singleRun` from caps. |
| D8 | #4 | Ship the `pg_advisory_xact_lock` alone, or also add the partial-unique-index backstop (needs `Job.clientId` denorm + migration)? | Advisory lock alone for tonight; index backstop as a fast-follow. |

## Overnight readiness by feature

- **Ships tonight, no blocking decision:** #7 (drain), #3 (health, D6 default), #6
  (readiness, D5 default), #4 (governor, D7/D8 defaults), #5 **Phase 1** (drill +
  freshness, local-testable).
- **Ships tonight but a slice waits on D1/D2/D3:** #2 (build the `/cutover` console +
  verify logic; the live blob/Delinea path waits on infra), #5 **Phase 2** (blob upload).
- **Depends on #4 landing first:** #1 (runner pool) — build it, keep `-PoolSize 1`
  byte-compatible, enable size > 1 only once #4 is in (S7).
