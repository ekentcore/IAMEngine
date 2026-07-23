# Go-live readiness preflight report (design)

Date: 2026-07-22
Feature: finalization batch #6

## 1. Purpose & gap

Hosting migrates to Azure **tomorrow**. Before the team runs the first *real* onboard /
offboard against the migrated environment, someone needs a single, unambiguous answer to:
**"are we allowed to go live?"** Today that answer is scattered across five surfaces —
`/health` (global integrations), `/tools/fleet-m365` (M365 credential sweep),
`/health/connections` (every conn-test row), the Agents page (online / build state), and
Settings → DB backup card. An operator has to visit all of them, remember the freshness
window of each, and mentally AND them together. Nothing tells them *"the runner build the
agents are on is stale"* or *"the agents are still pointed at the old app URL"* — the two
failure modes an Azure cutover most plausibly produces.

The gap is **aggregation and a verdict**, not new probes. Every signal already exists as a
tested helper. This feature is a read-mostly page that pulls those signals into one
**check registry**, rolls them up **per in-scope client** and **globally**, and prints one
**GO / NO-GO** banner with per-check remediation hints. It is a *point-in-time gate*, not an
ongoing monitor (that is #3, the health board — see §4).

Two go-live-specific checks have no existing surface and are the only genuinely new logic:
**DB migrations applied** (schema matches code) and **agents converged on the new app URL**
(the Azure cutover check).

## 2. Current state (file:line)

Everything below is reused verbatim; the preflight calls these, it does not reimplement them.

- **Global integration checks** — `runHealthChecks()` in `web/lib/health/checks.ts:214`
  returns `HealthResult[]` (`{ name, status: "ok"|"fail"|"not_configured", detail, latencyMs }`,
  type at `:21-22`). Covers Postgres (`:58`), Redis (`:72`), Delinea (`:102`), Delinea write
  rights (`:119`), ServiceNow (`:164`), Azure OpenAI (`:178`), and near-term credential expiry
  (`:190`, reads `Secret.expiresAt` + `ConnHealthState.credExpiresAt`). These are **live and
  synchronous** — direct API calls from the app process, safe to run at page load. The
  `/api/health` route (`web/app/api/health/route.ts`) already returns 503 when any check fails.
- **Per-client M365 credential health** — `rollupFleetM365Test(db, scope)` in
  `web/lib/jobs/fleet-m365-test.ts:323`, classifying each in-scope M365-family client from the
  durable `ConnectionTest` rows (`classifyM365Client` `:80`, status `ok|fail|running|pending|
  unverified|untested` `:45`). Reads the **last sweep**; a fresh sweep is a separate async
  dispatch via `startFleetM365Test` (`:229`). `FLEET_M365_STALE_AFTER_MS = 10min` (`:25`).
- **Per-client run-readiness** — `computeClientReadiness` in `web/lib/clients/readiness.ts:108`
  (tier `ready|partial|not_set_up|no_systems` `:12`), already assembled per client by
  `makeClientRepository(db).listClients(scope)` (`web/lib/clients/repository.ts:88`, wires
  readiness at `:201`, `modeled` flag at `:194`). Folds in wired secrets + `ConnectionTest`
  `fieldsOk`/`accessOk` + rights rollup, and treats NOT_NEEDED secrets as satisfied
  (`isNotNeededForTest` semantics live here as `notNeeded`, `:117`).
- **Agent online state** — `AGENT_ONLINE_MS = 90_000` in `web/lib/runner/reachability.ts:17`
  (mirrors the `ONLINE_MS` literal in `runner-service.ts:571`). `clientRunnerReachability`
  (`:86`) / `computeReach` (`:37`) answer "does THIS client have an online, in-scope, capable
  agent" including on-prem host-affinity and RSAT/browser capability gating.
- **Runner build-sync** — `runnerBuildId()` / `runnerBundle()` in `web/lib/runner/bundle.ts:99`
  / `:118` compute the content-hash of the served runner tree. The claim() **stale-code guard**
  (`web/lib/jobs/runner-service.ts:641-646`) refuses to hand jobs to an agent whose reported
  `Agent.version` (the content-hash build id) ≠ `runnerBuildId()`. Same comparison drives the
  preflight check.
- **Wedged / stale jobs** — `PROGRESS_STALE_MS = 20min` (`runner-service.ts:128`), the cutoff
  the wedged-running-job reclaim keys off `Job.progressAt` (`:603`); `LEASE_MS` stale-dispatch
  reclaim (`:583`). `Job.status` enum `pending|dispatched|running|succeeded|failed|manual|
  skipped` (schema `:56`).
- **Backup freshness** — `dbBackupStatus(raw)` / `backupDue(s, now)` in
  `web/lib/jobs/db-backup.ts:78` / `:93`, reading `AppSetting[DB_BACKUP_KEY]`
  (`lastStartedAt`, `lastResult.ok`, `lastResult.at`).
- **Client scope** — `currentClientScope(db)` / `scopeAllows` / `clientIdWhere` in
  `web/lib/auth/client-scope.ts:59` / `:77` / `:84`. In-scope-for-*build* additionally excludes
  archived (`Client.archivedAt`, schema `:161`), `engineOptOut` (`:135`), and roster-only rows
  (`backbone == null`, `:97` in repo select); CLAUDE.md parks PGLS + "Needs Cleanup / Document
  Missing / N/A" clients.
- **Agent URL migration** — `Agent.currentAppUrl` / `migratedAt` / `migrateError` (schema
  `Agent` model `:257`+; heartbeat convergence in `runner-service.ts:435-455`),
  `web/lib/agents/migrate-status.ts:migrateStatus`. The Azure-cutover signal.
- **No existing surface**: `prisma migrate status`. There is no in-app read of `_prisma_migrations`
  vs the `web/prisma/migrations/*` directory today (latest dir `20260722120000_fleet_m365_test_run`).

## 3. Design

### 3.1 The check registry

A declarative array of check descriptors, `web/lib/golive/checks.ts`. Each descriptor is data —
adding a check is one entry, matching the "extensible tooling" preference. The registry never
*runs* probes itself; each check's `evaluate` maps an already-loaded snapshot to a verdict, so
the whole page renders from one batched load (§3.3).

```ts
type Verdict = "pass" | "warn" | "fail" | "na";   // na = not applicable / not configured
type CheckScope = "global" | "per-client";
type Liveness   = "live" | "cached";              // §3.5

type CheckResult = {
  id: string;
  verdict: Verdict;
  headline: string;         // "Runner build in sync"
  detail: string;           // "3 of 4 online agents are on build a1b2c3"
  remediation?: string;     // shown only on warn/fail — the actionable fix
  liveness: Liveness;
  blocking: boolean;        // does a fail flip the verdict to NO-GO? (see §3.4)
};

type GlobalCheck    = { id; scope: "global";     blocking; liveness; evaluate(s: Snapshot): CheckResult };
type PerClientCheck = { id; scope: "per-client"; blocking; liveness; evaluate(s: Snapshot, c: ClientState): CheckResult };
```

`Snapshot` is the batched read (§3.3); `ClientState` is one in-scope client's slice of it.
`evaluate` is **pure** over the snapshot — unit-testable without a DB (mirrors `computeReach` /
`classifyM365Client` / `computeClientReadiness`, all already pure).

### 3.2 The checks and their sources

**Global checks** (one row each, scope `global`):

| id | Source | pass / warn / fail | Liveness | Blocking |
|----|--------|--------------------|----------|----------|
| `db` | `runHealthChecks()` Postgres result | ok→pass, fail→fail, not_configured→fail | live | yes |
| `delinea` | `runHealthChecks()` Delinea + Delinea rights | both ok→pass; rights not_configured→warn; either fail→fail | live | yes |
| `servicenow` | `runHealthChecks()` ServiceNow | ok→pass, not_configured→warn, fail→fail | live | no |
| `azure-ai` | `runHealthChecks()` Azure OpenAI | ok→pass, not_configured→na, fail→warn | live | no |
| `cred-expiry` | `runHealthChecks()` cred-expiry | ok→pass, fail (something expires <window)→warn | live | no |
| `central-runner-online` | `db.agent` where `clientId=null`, `lastSeenAt > now-AGENT_ONLINE_MS` | ≥1→pass, 0→fail | live | yes |
| `runner-build-sync` | `runnerBuildId()` vs each online `Agent.version` | all match→pass; some stale→warn; **zero** on current build→fail | live | yes |
| `agent-url-converged` | `migrateStatus` over all enabled agents vs `AppSetting[agent_migration].appUrl` | all converged→pass; some pending→warn; any `migrateError`→fail | live | yes (during cutover) |
| `db-migrations` | §3.6 | all applied, none failed→pass; drift→fail | live | yes |
| `backups-fresh` | `dbBackupStatus(AppSetting[db_backup])` | last ok < 24h→pass; enabled but stale/failed→warn; disabled→warn | cached | no |
| `wedged-jobs` | count `Job` status=running, `progressAt < now-PROGRESS_STALE_MS` (+ old pending on non-paused cases) | 0→pass; >0→warn | live | no |

**Per-client checks** (one row per in-scope client, rolled up — §3.3):

| id | Source | pass / warn / fail | Liveness |
|----|--------|--------------------|----------|
| `client-creds-ready` | `computeClientReadiness` tier (from `listClients(scope)`) | ready→pass; partial→warn; not_set_up→fail; no_systems→na | cached |
| `client-m365` | `rollupFleetM365Test` row for the client | completed/ok→pass; unverified/over_permissioned→warn; fail/missing_perms/no_creds→fail; untested→warn; running/pending→warn | cached |
| `client-agent-reachable` | `clientRunnerReachability` over the client's on-prem systems | all servable→pass; any not servable→fail; no on-prem systems→na | live |

Rationale for a few verdicts:
- `runner-build-sync` is **fail** only when *no* online agent is on the current build (nothing
  can run at all — exactly what claim() enforces at `:641`); a *partial* stale fleet is **warn**
  because dispatch still succeeds on the current-build agents and stale ones self-update.
- `agent-url-converged` is the Azure-specific gate. It is blocking **while a migration target is
  set**; if `AppSetting[agent_migration]` is empty (no cutover in progress) it evaluates to `na`
  and drops out — so the check is inert on a normal day and hard on cutover day.
- `client-m365` mirrors the fleet-m365 classifier so the two pages never disagree.
- `client-agent-reachable` is the only per-client **live** check — it reads current `lastSeenAt`,
  not a stored test — because "is the agent up *right now*" is the whole point of a go-live gate.

### 3.3 The aggregation loader

`web/app/golive/_lib/loader.ts` (the S5 loader seam — §4), one function `loadGoLivePreflight()`:

1. Resolve scope: `currentClientScope(db)`; gate on a permission (`audit.view` at minimum — same
   as `/health/connections`; consider `client.edit_secrets` since it exposes fleet cred state).
2. **One batched load** into a `Snapshot`, in parallel (`Promise.all`):
   - `runHealthChecks()` (global integrations, live)
   - `rollupFleetM365Test(db, scope)` (cached M365 rows — advances the sweep on poll but never
     dispatches)
   - `makeClientRepository(db).listClients(scope)` (per-client readiness + `modeled`)
   - online agents: `db.agent.findMany({ where: { enabled, deletedAt: null, lastSeenAt: >cutoff } })`
     + `runnerBuildId()` + `AppSetting[agent_migration]`
   - `dbBackupStatus(await getAppSetting(db, DB_BACKUP_KEY))`
   - wedged-job counts (two cheap `db.job.count`s)
   - migration state (§3.6)
   - `clientRunnerReachability` per client **only for clients with on-prem systems** (skip cloud-only
     clients — they need no own-agent).
3. Filter clients to the **go-live in-scope set**: `scopeAllows` ∧ `!archivedAt` ∧ `!engineOptOut`
   ∧ `backbone != null` (roster-only rows are not run against) ∧ `modeled`. This is the same
   population the top-20 build order targets; parked clients (PGLS et al.) fall out via
   `engineOptOut` / unmodeled.
4. Run every registry `evaluate` over the snapshot → `CheckResult[]` (global) and, per client,
   a `ClientRollup`.
5. Serialize Dates → ISO for the client island.

The loader is **read-only**. It never calls `claim()`, never dispatches a job, never mutates a
`ConnectionTest`. (`rollupFleetM365Test` does opportunistically settle a *stale* run row to
"done" — that is existing advance-on-poll behavior, not a preflight side effect.)

### 3.4 Per-client rollup + global rollup + GO / NO-GO verdict

Verdict ordering: `fail > warn > pass` (`na` ignored). Two pure reducers in
`web/lib/golive/rollup.ts`:

- **Per-client rollup**: worst verdict across that client's per-client checks →
  `{ slug, name, verdict, checks: CheckResult[] }`. A client is **NO-GO** if any of its
  per-client checks fails.
- **Global rollup / overall verdict**:
  - `NO-GO` if **any blocking check** (global or per-client) is `fail`.
  - `GO WITH WARNINGS` if no blocking fail but ≥1 `warn` (or a non-blocking `fail`).
  - `GO` if every check is `pass`/`na`.

The overall verdict is computed only from **blocking** checks for the hard gate, but the banner
also surfaces the warn count so nobody reads "GO" as "flawless". A non-blocking fail (e.g.
ServiceNow down) degrades to "GO WITH WARNINGS", not NO-GO — you can run cases without SN work
notes flushing, you cannot run them with a dead DB or an offline central runner.

Page layout (host design system — flat, minimal borders, sentence case, no gradients):
1. **Verdict banner**: big GO / GO WITH WARNINGS / NO-GO + counts (`X blocking failures ·
   Y warnings · Z clients not ready`) + the snapshot timestamp.
2. **Global checks** table: one row per global check, verdict chip + detail + remediation.
3. **Per-client** table: one row per in-scope client, its rollup verdict + a compact chip per
   per-client check; expandable to the check details. Sort NO-GO clients to the top.
4. A **"Run fresh M365 sweep"** button (§3.5) and a **"Re-run checks"** button (re-fetch).

### 3.5 Live-probe vs cached decision

The hard rule: **the page load never dispatches anything to a runner.** Runner probes
(connection tests, M365 sign-ins) are async — the result lands seconds-to-minutes later on a
*different* request, and a fleet M365 sweep fires a real Graph sign-in per client, which is
exactly the scripted-login burst risk-based Conditional Access challenges (documented at
`fleet-m365-test.ts:229` "never `deep`"). So:

- **Live at load** (cheap, synchronous, in-process): all `runHealthChecks()` integrations, agent
  online counts, build-sync, URL convergence, migration state, wedged-job counts, per-client
  agent reachability. These reflect *now*.
- **Cached read** (last known result of an async probe): per-client M365 classification and
  per-client creds-readiness both read the durable `ConnectionTest` rows. The banner shows the
  **age** of the most recent sweep (`FleetM365TestRun.finishedAt`); if the newest sweep is older
  than `FLEET_M365_STALE_AFTER_MS` the `client-m365` details carry a "sweep is stale — re-run"
  remediation.
- **Explicit refresh**: the "Run fresh M365 sweep" button POSTs the existing
  `/api/tools/fleet-m365` (calls `startFleetM365Test`), then the page polls its GET to advance —
  reusing that tool's whole lifecycle. Preflight does **not** own a sweep dispatcher.

This keeps the page instant and idempotent on load, and makes freshness an explicit operator
action rather than a hidden fan-out.

### 3.6 DB migrations-applied check

No child process (`prisma migrate status` needs the Prisma CLI + engine on the host, unreliable
under the Azure app runtime). Instead, a cheap raw read compared to the shipped migrations
directory, in `web/lib/golive/migration-status.ts`:

- Applied set: `db.$queryRaw` over `_prisma_migrations` → `{ migration_name, finished_at,
  rolled_back_at }`. A row is *applied* when `finished_at IS NOT NULL AND rolled_back_at IS NULL`.
- Expected set: directory names under `web/prisma/migrations/` (excluding `migration_lock.toml`),
  read once with `fs.readdirSync` (same read style as `bundle.ts`).
- Verdict: every expected migration present-and-applied → `pass`; any expected migration missing
  or unapplied, or any applied row with a non-null `rolled_back_at`/failed state → `fail` with
  the offending names in `detail`. An expected count of 0 or an unreadable table → `warn`
  ("could not verify schema state"), never a false `pass`.

This directly answers "DB schema matches code" — the migration files are part of the deployed
bundle, so a mismatch means the Azure deploy shipped code ahead of (or behind) the DB.

## 4. Shared-seam conformance

Grounded in the S5 loader pattern already in the repo (`web/app/clients/_lib/loader.ts`,
`web/app/health/connections/_lib/loader.ts`); the batch seams doc
`docs/superpowers/specs/2026-07-22-finalization-seams-and-sequencing.md` is a **peer spec drafted
in the same batch and not yet on disk** — this design commits to S5 as stated in the batch brief.

- **S5 — additive page, reuse the loader seam + host design system.** New route `web/app/golive/`
  with page-data assembly isolated in `_lib/loader.ts`; the page/component only render its output
  (exactly the `/clients` and `/health/connections` split). No existing page or route changes. UI
  follows the host design system (flat, sentence case, verdict chips reuse the `/health` chip
  vocabulary `ok|fail|not_configured` extended with `warn`).
- **Read-only aggregation — never touches `claim()`.** §3.3 / §3.5: the loader reuses
  `runHealthChecks`, `rollupFleetM365Test`, `computeClientReadiness`/`listClients`,
  `runnerBuildId`, `clientRunnerReachability`, `dbBackupStatus`, and `migrateStatus` as-is. The
  only new evaluators are pure reducers over their output plus the migration-status read.
- **Overlap with #3 (health board).** #3 is *ongoing ops health* (a live-polling board an
  operator watches during the day); #6 is a *point-in-time go-live gate* (one verdict, run before
  cutover). They share the **underlying signal queries**, which is why those signals must stay in
  their existing library homes (`lib/health/checks.ts`, `lib/runner/reachability.ts`,
  `lib/runner/bundle.ts`, `lib/jobs/*`) and **not** be inlined into either page. Proposed shared
  helper: `web/lib/ops-signals/` re-exporting the online-agent query, build-sync comparison, and
  wedged-job counts as small pure functions both #3 and #6 import. If #3 lands first, #6 imports
  from it; if #6 lands first, #6 puts them in `lib/ops-signals/` and #3 imports from there. The
  registry itself (`lib/golive/checks.ts`) and the GO/NO-GO reducer are #6-only — #3 has no verdict.

## 5. Testing

Pure unit tests (no DB), matching the repo's existing `.test.ts` style
(`reachability.test.ts`, `fleet-m365-test.test.ts`, `db-backup.test.ts`):

- **`golive/checks.test.ts`** — each `evaluate` against hand-built `Snapshot` fixtures: every
  verdict branch per check (e.g. build-sync pass/partial-warn/all-stale-fail; agent-url `na` when
  no target set, warn when pending, fail on `migrateError`; db-migrations pass/drift/unreadable).
- **`golive/rollup.test.ts`** — the reducers: NO-GO on one blocking fail; GO-WITH-WARNINGS on a
  non-blocking fail; per-client worst-verdict rollup; `na` exclusion; NO-GO clients sort first.
- **`golive/migration-status.test.ts`** — applied vs expected set diffing, `rolled_back_at`
  handling, empty/unreadable → warn.
- The reused helpers (`computeClientReadiness`, `classifyM365Client`, `computeReach`,
  `backupDue`, `runnerBuildId`) already have their own tests — the preflight tests assert *wiring
  and verdict mapping*, not their internals.

Manual verification on the dev DB (per the web-dev-verify recipe): mint a session, hit
`/golive`, confirm the verdict banner matches the individual surfaces (`/health`,
`/tools/fleet-m365`, Agents), and that the page dispatches **zero** jobs (watch the `Job` table /
audit log across a reload).

## 6. Sequencing & dependencies

1. `lib/golive/migration-status.ts` (+ test) — self-contained, no deps.
2. `lib/golive/checks.ts` registry + types (+ test) — depends on the shape of the reused helpers
   only; pure.
3. `lib/golive/rollup.ts` (+ test) — depends on `checks.ts` types.
4. `app/golive/_lib/loader.ts` — the batched read; depends on 1–3 and all reused libs.
5. `app/golive/page.tsx` + `_components/preflight-view.tsx` — render + the two buttons.
6. (Optional, coordinate with #3) extract `lib/ops-signals/` and repoint 4 at it.

Dependencies / prerequisites:
- No schema migration, no runner change — **web-only, ship-safe on cutover day**.
- Depends on nothing from the other finalization features; it *reads* their outputs, so it is
  strictly more useful the more of them have landed, but it is correct standalone.
- Must land **before** the first real Azure case (that is its whole reason to exist) — highest
  priority in the batch for the day-of.

## 7. Open questions for Evan

1. **Permission gate.** `/health/connections` uses `audit.view`; the fleet M365 tool uses
   `client.edit_secrets` + all-clients. The preflight exposes fleet credential + agent state.
   Gate at `audit.view` (widely visible) or `client.edit_secrets` (fewer eyes on cred health)?
2. **Blocking set.** Proposed hard-blockers: `db`, `delinea`, `central-runner-online`,
   `runner-build-sync` (all-stale), `db-migrations`, `agent-url-converged` (during cutover).
   Should `client-agent-reachable` for an **on-prem** client be globally blocking, or only mark
   *that client* NO-GO while the overall verdict can still be GO-for-cloud-clients?
3. **Scope of the verdict.** GO/NO-GO over *all* in-scope clients, or a client picker so the team
   can go live for the top-20 first while the long tail is still amber?
4. **Sweep freshness policy.** Is a cached M365 sweep < N hours old acceptable for a GO, or must
   the operator run a fresh sweep and wait for it to settle before the gate will read GO? (Fresh
   = a Graph sign-in per client — a real Conditional-Access cost.)
5. **Agent-URL check trigger.** Read the cutover target from `AppSetting[agent_migration]`
   (inert when unset), or always show URL convergence with the expected Azure host hard-coded for
   the migration window?
6. **`na` clients.** Should `no_systems` / cloud-only-no-agent clients be hidden from the
   per-client table entirely, or shown greyed as "nothing to gate"?

## 8. Ordered implementation task breakdown

1. **Migration-status reader** — `web/lib/golive/migration-status.ts`: `$queryRaw` on
   `_prisma_migrations` + `readdirSync` of `web/prisma/migrations/`, diff → verdict. Unit test.
2. **Registry + types** — `web/lib/golive/checks.ts`: `Verdict`/`CheckResult`/`Snapshot`/
   `ClientState` types; the 11 global + 3 per-client descriptors, each `evaluate` pure over the
   snapshot, mapping the reused helpers' outputs (§3.2). Unit test every verdict branch.
3. **Rollup reducers** — `web/lib/golive/rollup.ts`: per-client worst-verdict + global GO/NO-GO
   over blocking checks. Unit test.
4. **Loader** — `web/app/golive/_lib/loader.ts`: scope + permission gate, the one batched
   `Promise.all` read, the go-live in-scope client filter, run the registry, serialize. Read-only.
5. **Page + view** — `web/app/golive/page.tsx` (thin, `force-dynamic`) + `_components/
   preflight-view.tsx`: verdict banner, global table, per-client table (NO-GO first, expandable),
   "Re-run checks" + "Run fresh M365 sweep" (POST/poll `/api/tools/fleet-m365`). Host design system.
6. **Nav link** — add `/golive` to the app nav (behind the chosen permission).
7. **(Optional, with #3)** extract `web/lib/ops-signals/` for the shared online-agent / build-sync
   / wedged-job queries and repoint the loader.
8. **Manual verify** — mint dev session, load `/golive`, cross-check the verdict against
   `/health`, `/tools/fleet-m365`, Agents; confirm zero jobs dispatched on load/reload.

---

**Summary.** Feature #6 is a web-only, read-only aggregation page (`/golive`) that pulls every
existing readiness signal — `runHealthChecks()` (global integrations), `rollupFleetM365Test`
(M365 cred sweep), `computeClientReadiness`/`listClients` (per-client wired+tested),
`runnerBuildId` vs online `Agent.version` (build-sync), `clientRunnerReachability` (agent online),
`dbBackupStatus` (backups), plus two new cheap live reads (`_prisma_migrations` drift and agent
URL convergence) — into a declarative **check registry**, rolls them up per in-scope client and
globally, and prints one **GO / NO-GO** verdict with remediation hints. The hard invariant: the
page **never dispatches to a runner** — everything cheap runs live at load, async probes
(conn-tests/M365) are read from their last cached result, and a fresh sweep is an explicit button
reusing the fleet-m365 lifecycle. It ships with no schema or runner change, so it is safe on Azure
cutover day. **Riskiest open question:** the sweep-freshness policy (§7.4) — whether a *cached*
M365 sweep may back a GO, or the gate must force a fresh Graph sign-in per client (a real
Conditional-Access cost) and wait for it to settle; this decides whether the verdict is instant or
gated on an async fan-out. **Shared files/helpers touched:** new `web/app/golive/*` and
`web/lib/golive/*` (registry, rollup, migration-status); *reuses unchanged*
`lib/health/checks.ts`, `lib/jobs/fleet-m365-test.ts`, `lib/clients/{readiness,repository}.ts`,
`lib/runner/{reachability,bundle}.ts`, `lib/jobs/db-backup.ts`, `lib/agents/migrate-status.ts`,
`lib/auth/client-scope.ts`; proposed `web/lib/ops-signals/` shared with #3 for the online-agent /
build-sync / wedged-job queries.
