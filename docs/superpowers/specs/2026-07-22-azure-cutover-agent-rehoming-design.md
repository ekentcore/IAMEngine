# Azure cutover + agent re-homing + DB-migration verification — design

Date: 2026-07-22. Feature #2 of the finalization set. Design spec only — no code in this doc.

## 1. Purpose & gap

Tomorrow morning the brain moves off the local Mac (launchd, `http://<lan-ip>:3000`) to
Azure (a new public domain). Every client-network agent is configured with the current
LAN URL as its `-AppUrl`. After the move they must all re-home to the Azure domain, and
the Postgres move must be proven intact (row counts + Delinea secret references + secrets
still resolvable from the new host) before we trust it. Today the pieces exist but there
is no *guided, verified, reversible* procedure that ties them together:

- **Re-homing machinery exists but is unguided.** The heartbeat `{migrate}` directive
  channel (PR #82) + the per-agent/fleet `agent_migration` AppSetting + the runner's
  `Invoke-CtgMigrate` already move one agent or the whole fleet. But there is no single
  screen that sequences *drain → push → verify every agent converged → verify the DB →
  rollback*, and no per-agent green/red "did it phone home to Azure?" board scoped to the
  cutover.
- **No DB-move verification.** Nightly `pg_dump`/`restore.sh` exist (PR #26), but nothing
  compares the restored Azure DB against the pre-dump Mac DB (row counts per key table,
  Secret→Delinea reference integrity, a live resolvability sample).
- **No split-brain guard or rollback story.** Nothing prevents both apps dispatching at
  once, handles agents that are offline during the window, or flips the fleet back if
  verification fails or an agent goes dark.

This feature adds a **guided cutover console** that orchestrates the existing directive
channel and adds the missing verification + rollback, storing all state in `AppSetting`
(no new Prisma model). It is a one-time-shaped tool but built to be re-runnable (any future
host move reuses it).

## 2. Current state (file:line refs)

**Directive channel (reuse — S2).**
- `web/lib/jobs/runner-service.ts:385-478` — `heartbeat(...)`. Reads the `agent_migration`
  AppSetting (`:438`), computes `migrateDecision` (`:440`), emits `migrate:{appUrl}`
  (`:441-447`), stamps `migrateDeliveredAt` and clears the one-shot canary
  (`migrateRequested`) on delivery (`:445`), and on a *converged* heartbeat
  (agent reports the target URL) stamps `migratedAt` + clears `migrateError`/`migrateRequested`
  (`:455`). A failed **proof** canary is retired server-side at `:460-463`.
- `web/lib/jobs/agent-migration.ts` — `AGENT_MIGRATION_KEY = "agent_migration"`;
  `AgentMigrationSetting = { enabled?, targetUrl?, proofAgentId? }`; `migrateDecision(...)`
  (emit while `current != target`; `converged` when equal); `normalizeUrl` (trailing-slash/
  case-insensitive compare); `nextMigrationSetting` (proof pointer survives only while the
  target it proved is unchanged).
- `web/app/api/agents/heartbeat/route.ts` — POST body carries `appUrl` (the base the agent
  is polling, runner 1.62+) and `migrateError`; returns `{ ..., migrate: {appUrl}|null }`.
- `web/app/api/admin/agent-migration/route.ts` — POST `{ enabled, targetUrl }`, guard
  `settings.manage`, validates absolute http(s), writes via `nextMigrationSetting`, audits
  `agent.migration.configure`.

**Runner side (S4 — already exists; enumerate touches, don't rebuild).**
- `runner/Start-IamRunner.ps1:3222-3232` — heartbeat POST includes `appUrl=$AppUrl` and
  `migrateError`; on `$hb.migrate.appUrl` calls `Invoke-CtgMigrate`.
- `runner/Start-IamRunner.ps1:2147-2207` — `Invoke-CtgMigrate`: (1) VERIFY authenticated GET
  of `/api/runner/manifest` on the new host with the existing `$ApiToken` (`:2159-2167`);
  (2) REWRITE the supervisor entry — Scheduled Task / launchd plist / systemd unit — replacing
  `-AppUrl` (old removed, not appended) (`:2170-2197`); (3) SWITCH `$script:AppUrl` + relaunch
  (`:2199-2206`). On any failure it records `$script:LastMigrateError` and does **not** relaunch.
- `runner/VERSION` = `1.94.0`.

**Agent model + view.**
- `web/prisma/schema.prisma:257-313` — `Agent`: `currentAppUrl`, `migrateRequested`,
  `migrateRequestedAt/By`, `migrateDeliveredAt`, `migratedAt`, `migrateError`, `lastSeenAt`,
  `enabled`, `scope`, `clientId`, `priority`, `version`.
- `web/app/agents/_lib/loader.ts` — shared v1/v2/v3 loader; already surfaces the migration
  setting (`:38-43`) and every migrate timestamp on each `AgentVM` (`:102-108`).
- `web/lib/agents/migrate-status.ts` — pure `migrateStatus(agent, targetUrl, now)` →
  `failed | migrated | queued | returned-old | moving | moving-quiet`. This is the exact
  per-agent verdict the cutover board needs; reuse verbatim.
- `web/app/agents/_components/{agents-view,change-url-modal,proof-success-modal}.tsx`,
  pages `agents/{page,v2/page,v3/page}.tsx`.

**DB backup / restore (reuse for the DB half).**
- `web/lib/jobs/db-backup.ts` — `runDbBackup(s)` does `pg_dump --format=custom`, verifies with
  `pg_restore --list`, counts `TABLE DATA` markers into `dataTables`, promotes `latest.dump`.
  `findPgBin`, `sanitizeError`, `DB_BACKUP_KEY`.
- `web/scripts/db-backup/{backup.sh,restore.sh,install-schedule.sh,README.md}` — the standalone
  layer; `restore.sh` restores to a scratch DB by default.

**Delinea resolution (for secret-integrity checks).**
- `web/lib/secrets/delinea.ts` — `delineaConfigFromEnv()`, `delineaConfigured(cfg)`,
  `getDelineaToken(cfg)`, `checkSecret(cfg, externalId, fetcher?, token?)`,
  `resolveSecretFields(cfg, externalId, fetcher?, token?)`.
- `web/prisma/schema.prisma:216-231` — `Secret { clientId, name, externalId (Delinea id,
  never a value), provider }`.

**Health / self-heal / app URL.**
- `web/app/api/health/probe/route.ts` — public `{ probe:"iam", db:bool }` liveness marker.
- `web/lib/watchdog/self-heal.ts` — the app watches itself; `supervised` on Azure is true via
  `WEBSITE_SITE_NAME` (see `web/lib/supervised.ts`, per the 2026-07-17 spec).
- App's own public URL: `process.env.APP_PUBLIC_URL` (notification deep-links,
  `runner-service.ts:630,1816`). This env must be set to the Azure domain on the Azure host,
  separately from `agent_migration.targetUrl`.

**Settings plumbing.**
- `web/lib/settings.ts` — `getAppSetting`, `setAppSetting`, `claimAppSetting` (CAS).
- `web/app/settings/_lib/loader.ts` — `loadDbBackupStatus()` pattern to mirror.

**Drain / pause (dependency #7).**
- Claim query excludes paused cases: `web/lib/jobs/runner-service.ts:685`
  (`case.pausedAt: null`). `CaseRequest.pausedAt/pausedReason` is the existing quiesce lever.
  Feature #7 owns the fleet-wide dispatch freeze/drain — this feature *consumes* it.

## 3. Design

A guided cutover console at **`/cutover`** (new page, additive — S5), driven by one
`AppSetting` state machine (`cutover` key) and three new admin routes. It sequences six
phases and offers rollback. No new Prisma model.

### Component A — Cutover state machine (`web/lib/jobs/cutover.ts`, pure)

- **What it does.** Defines the durable cutover record and the pure transitions/derivations,
  mirroring `agent-migration.ts`/`db-backup.ts` (pure, `tsx --test`able; the repo's test glob
  covers `lib/`).
- **Shape.**
  ```
  CUTOVER_KEY = "cutover"
  CutoverState = {
    phase: "idle" | "staged" | "draining" | "pushing" | "verifying-agents"
         | "verifying-db" | "complete" | "rolled-back";
    azureUrl: string;            // the new target
    oldUrl: string | null;       // captured at stage time = the fleet's current common URL (for rollback)
    startedBy: string | null;    // operator email
    stagedAt / pushedAt / completedAt / rolledBackAt: string | null;
    baseline: DbBaseline | null; // captured pre-dump (Component D)
    dbVerify: DbVerifyResult | null;
    acknowledgedStragglers: boolean; // operator accepted "complete with N offline agents"
  }
  ```
- **Pure fns.** `normalizeCutover(raw)`; `canAdvance(state, to)` (guards illegal jumps);
  `nextPhase(state, action)`; `agentRehomeVerdict(agentVM, azureUrl, now)` → wraps
  `migrateStatus` + online/offline into `{ agentId, name, kind: "green"|"red"|"pending",
  reason }` (green = `migrated` && seen < 90s; red = `failed`/`returned-old`, or offline &&
  not converged; pending = `queued`/`moving`/`moving-quiet` && recently seen);
  `fleetRehomeSummary(verdicts)` → `{ total, green, red, pending, offlineUnconverged }`.
- **Deps.** `agent-migration.ts` (`normalizeUrl`), `migrate-status.ts`.

### Component B — Cutover console page (`web/app/cutover/page.tsx` + `_lib/loader.ts` + `_components/cutover-view.tsx`)

- **What it does.** One screen with a phase stepper and a per-phase action button, plus the
  live agent re-home board and the DB-verify panel. Follows the host design system (flat,
  minimal borders, sentence case) and the shared-loader pattern (S5).
- **Loader (`_lib/loader.ts`).** Reads the `cutover` AppSetting, the `agent_migration`
  setting, and reuses `loadAgentsPage()`'s agent VMs (or the same queries) to compute
  `agentRehomeVerdict` per agent against `azureUrl`. Returns `{ state, verdicts, summary,
  migration }`. `force-dynamic`.
- **View.** Client component; live-polls (like the agents page) while `phase` is in
  `pushing|verifying-agents|verifying-db`. Renders:
  - **Phase stepper** (1 pre-stage → 6 rollback-available) with the current phase highlighted.
  - **Agent board**: one row per agent — name, scope/client, `currentAppUrl`, a green/red/pending
    chip from `agentRehomeVerdict`, and the raw `migrateStatus` label underneath. A summary pill
    (`N of M re-homed · K red · J offline`). This is the cutover-scoped view of feature #3's
    "all agents re-homed?" signal (#3 is the general fleet-health board; do not build it here —
    just consume the same verdict data).
  - **DB-verify panel**: the `DbVerifyResult` table (per-table baseline vs current counts,
    secret-ref integrity, resolvability sample), Run/Re-run button.
  - **Buttons**, each a POST to Component C: *Stage Azure URL*, *Drain* (delegates to #7),
    *Push to fleet*, *Verify DB*, *Confirm cutover*, *Roll back*.

### Component C — Cutover control route (`web/app/api/admin/cutover/route.ts`)

- **What it does.** The single write path for phase transitions; guard `settings.manage`;
  every action audited. POST `{ action, azureUrl? }` where `action ∈ { stage, push, confirm,
  rollback, ackStragglers }`.
- **Interface / behavior.**
  - `stage { azureUrl }`: validate absolute http(s) (reuse the agent-migration validator).
    Capture `oldUrl` = the fleet's current common `currentAppUrl` (the mode across enabled
    agents; if agents disagree, surface a warning — that itself is pre-existing split-brain).
    Write `cutover.phase="staged"`, `azureUrl`, `oldUrl`. Do **not** touch `agent_migration`
    yet. Audit `cutover.stage`.
  - `push`: precondition `phase ∈ {staged, draining}` **and** the drain gate reports quiesced
    (from #7). Write `agent_migration = { enabled:true, targetUrl: azureUrl, proofAgentId:null }`
    via `setAppSetting` (this is the existing fleet-migrate switch — the heartbeat does the rest),
    set `cutover.phase="pushing"`, `pushedAt`. Audit `cutover.push` + the existing
    `agent.migration.configure`.
  - `confirm`: precondition all agents green (or `acknowledgedStragglers`) **and**
    `dbVerify.ok`. Set `phase="complete"`. Leaves `agent_migration.enabled=true` so late/offline
    agents still re-home when they surface (the Mac "lighthouse" keeps serving the directive).
    Audit `cutover.confirm`.
  - `rollback`: write `agent_migration = { enabled:true, targetUrl: oldUrl, proofAgentId:null }`.
    Because `migrateDecision` is symmetric (emit while `current != target`), agents on Azure get
    a `migrate` back to `oldUrl` on their next heartbeat; `Invoke-CtgMigrate` verifies the old
    host reachable before switching, so it is safe. Set `phase="rolled-back"`. Audit
    `cutover.rollback`. **Precondition for safety:** the old Mac app must still be reachable
    (checked live in the loader; button disabled otherwise).
  - `ackStragglers`: set `acknowledgedStragglers=true` (operator accepts completing with N
    offline-unconverged agents). Audit `cutover.ack_stragglers`.
- **Drain (`draining`) is NOT owned here** — the button calls #7's drain endpoint; this route
  only reads its "quiesced" signal as a `push` precondition.

### Component D — DB baseline + verification (`web/lib/jobs/cutover-db.ts` + route `web/app/api/admin/cutover/db-verify/route.ts`)

- **What it does.** Proves the Postgres move was lossless and that secrets still resolve
  **from the new host**, with no cross-origin calls: the baseline is written into the DB on the
  Mac *before* the dump, travels inside the dump, and is compared against a fresh recount on
  Azure *after* restore.
- **`DbBaseline`** (captured at `stage` time, or by an explicit "Capture baseline" pressed on
  the Mac just before the dump): `{ capturedAt, tables: Record<tableName, count>,
  secretCount, secretRefHash }` where `secretRefHash` = a stable hash over the sorted
  `(clientId,name,externalId)` triples (detects any dropped/rewritten Delinea reference).
  Stored inside `cutover.baseline` (an `AppSetting` row → included in `pg_dump`).
- **Key tables counted** (the volume/critical set from `schema.prisma`): `Client`,
  `ClientSystem`, `Secret`, `CaseRequest`, `Job`, `Agent`, `AuditLog`, `ConnectionTest`,
  `ConnHealthState`, `SystemSetupState`, `AppSetting`, `Document`, `FeatureRequest`, plus a
  `COUNT(*)`-driven sweep of every remaining `public` table (via `information_schema` /
  Prisma `_count`) so nothing is silently missed. (34 models exist; the named ones are the
  go-live-critical rows, the rest are counted for completeness.)
- **`db-verify` route (Azure).** Guard `settings.manage`. Recompute counts + `secretRefHash`
  on the current (Azure) DB; diff against `cutover.baseline`. Then **Delinea integrity**:
  `delineaConfigFromEnv()` + `getDelineaToken()`; sample-resolve secrets via
  `checkSecret`/`resolveSecretFields` — a bounded sample per client plus **all** GA/app-reg
  secrets — recording `{ resolvable, unresolvable: [{clientId,name,error}] }`. Values never
  leave the function (names + error strings only). Returns `DbVerifyResult = { ok, tables:
  [{name, baseline, current, delta}], secretRefMatch, delineaConfigured, resolvable,
  unresolvable[], at }`; persist onto `cutover.dbVerify`. `ok` = every delta 0 **and**
  `secretRefMatch` **and** zero `unresolvable`.
- **Deps.** `db-backup.ts` (`findPgBin` not needed here — counts come through Prisma; only the
  human dump/restore uses pg tools), `delinea.ts`, `cutover.ts`.

### Data flow

```
Operator @ /cutover                     Mac app (old)                 Azure app (new)
  Stage azureUrl ───────────────► cutover.phase=staged, oldUrl captured
  Capture baseline ─────────────► cutover.baseline written (AppSetting, in DB)
  [human] pg_dump on Mac ────────► dump file (carries cutover.baseline)
  [human] restore on Azure ───────────────────────────────► Azure DB (has baseline)
  Drain (calls #7) ─────────────► dispatch quiesced on Mac
  Push ─────────────────────────► agent_migration{enabled,targetUrl=azureUrl}
        (Mac app keeps serving this as the redirect "lighthouse")
  ...heartbeats... each agent: Invoke-CtgMigrate → verify Azure → rewrite supervisor → switch
  Verify agents ────────────────► board reads currentAppUrl per agent (green when ==azureUrl)
  Verify DB (on Azure) ─────────────────────────────────────► db-verify: counts+refHash+resolve
  Confirm (all green + dbVerify.ok) ► phase=complete
  Rollback (any failure) ───────► agent_migration.targetUrl=oldUrl → agents re-home back
```

### Prisma changes

**None.** All cutover state lives in the `AppSetting` table under key `cutover` (same pattern
as `agent_migration`, `db_backup`, `setup_gate`). This deliberately avoids an overnight
migration on the shared DB (see the DB-reset incident memory). Open question 7.3 asks whether
Evan wants a durable `CutoverRun` audit table for history — deferred by default.

### API / contract changes

- **No change to the runner↔app contract (S2/S4 honored).** The heartbeat `{migrate}` channel,
  its request fields (`appUrl`, `migrateError`), and `Invoke-CtgMigrate` are reused unchanged.
- New **admin-only** routes (browser session, guard `settings.manage`): `POST
  /api/admin/cutover`, `POST /api/admin/cutover/db-verify`. These are operator surfaces, not
  runner surfaces.

### Error handling & idempotency

- **Every transition is idempotent.** Re-`push` re-writes the same `agent_migration` value
  (no-op); re-`stage` before push is allowed; `db-verify` is read-only + recomputable any number
  of times. Phase writes use `claimAppSetting` (CAS) so two admins can't race the machine.
- **`migrateDecision` convergence is the safety net.** Fleet `enabled=true` re-emits the
  directive every heartbeat until `currentAppUrl == target`, so a dropped directive, a crashed
  runner, or an agent offline for days simply re-homes when it next polls — no per-agent retry
  logic needed here.
- **A failed re-home never loops the runner** — `Invoke-CtgMigrate` verifies reachability and
  rewrites the supervisor entry *before* switching, and on any failure records `migrateError`
  and stays put (`Start-IamRunner.ps1:2159-2197`). The board renders that as a red row.
- **db-verify never throws to the client**; Delinea unreachable → `delineaConfigured:false` and
  a clear panel note (mirrors `preflightConnTestFields`' behavior).

### Rollback

Two independent levers, both reversible:
1. **Agents:** `rollback` sets `agent_migration.targetUrl = oldUrl` → the whole fleet re-homes
   to the Mac on the next heartbeat (symmetric `migrateDecision`). Requires the Mac app + LAN URL
   still reachable (loader checks; button disabled otherwise).
2. **Database/app:** the Azure DB is discarded; the Mac app keeps serving the (frozen, pre-dump)
   DB. Because dispatch is *frozen* on both sides during the window (drain #7 on the Mac; Azure
   stays in `pushing`/`verifying` with no `confirm`), no jobs execute against Azure before
   confirmation, so there is nothing to reconcile on rollback.

**Split-brain avoidance** is structural: (a) drain #7 stops the Mac dispatching before `push`;
(b) the cutover is not `complete` — and no operator resumes dispatch — until every agent is
green and `dbVerify.ok`; (c) the Mac app stays up as a read/redirect "lighthouse" so stragglers
re-home rather than continuing to poll a dead host. If `oldUrl` disagrees across agents at
`stage` time (pre-existing split), the console surfaces it before proceeding.

## 4. Shared-seam conformance

- **S2 (reuse heartbeat `{migrate}` channel):** honored. No new directive is invented; `push`
  and `rollback` only write the existing `agent_migration` AppSetting that
  `runner-service.heartbeat` already consumes.
- **S4 (runner-side migrate already exists):** **no runner files are touched by this feature.**
  `Invoke-CtgMigrate` and the heartbeat call site are used as-is. `runner/VERSION` (1.94.0) is
  **not** bumped by this feature — the single integration-time bump belongs to whichever feature
  actually changes runner code.
- **S5 (additive UI, shared loader + host design system):** honored. `/cutover` is a new page
  with its own `_lib/loader.ts` and `_components/`, reusing `loadAgentsPage` data,
  `migrate-status.ts`, and the flat/minimal design system. Existing agents pages are untouched.
- **Shared files this feature *reads* (no behavioral edit):** `web/lib/jobs/runner-service.ts`
  (heartbeat/claim — read only), `web/lib/jobs/agent-migration.ts`, `web/lib/agents/migrate-status.ts`,
  `web/app/agents/_lib/loader.ts`, `web/lib/secrets/delinea.ts`, `web/lib/jobs/db-backup.ts`,
  `web/lib/settings.ts`.
- **Shared files this feature *writes to the same AppSetting namespace* as:** `agent_migration`
  (written by `push`/`rollback`) — coordinated with the agents page, which reads it. New key
  `cutover` is exclusive to this feature.

## 5. Testing

- **`web/lib/jobs/cutover.test.ts`** (pure): `canAdvance` illegal-jump guards; `nextPhase` for
  each action; `agentRehomeVerdict` green/red/pending/offline matrix against a fake `azureUrl`
  and clock; `fleetRehomeSummary` tallies; `normalizeCutover` defaults.
- **`web/lib/jobs/cutover-db.test.ts`** (pure over injected count/secret snapshots):
  baseline-vs-current diffing, `secretRefHash` stability + mismatch detection, `ok` derivation
  (deltas + refMatch + zero unresolvable), unresolvable-secret aggregation with a stub Delinea
  fetcher (reuse the `Fetcher` seam in `delinea.ts`).
- **Existing suites stay green:** `agent-migration.test.ts`, `migrate-status.test.ts`,
  `db-backup.test.ts`, `self-heal.test.ts` — this feature doesn't modify their inputs.
- **Manual dress rehearsal (before go-live):** point one canary agent at a throwaway second URL
  of the *same* Mac app and drive stage→push→verify→rollback end to end; confirm the board goes
  green then returns on rollback. (This reuses the existing per-agent proof flow as the safe
  rehearsal path.)
- **Go-live runbook checks (documented on the page, not automated):** `DATABASE_URL`,
  `DELINEA_*`, `APP_PUBLIC_URL`, and the runner token secret are all set on Azure; the runner
  bearer token validates against Azure (`/api/runner/manifest` returns 200) — this is exactly
  what `Invoke-CtgMigrate`'s verify step exercises per agent.

## 6. Sequencing & dependencies

- **Depends on #7 (drain):** the `push` precondition reads #7's "dispatch quiesced" signal; the
  *Drain* button delegates to #7's endpoint. If #7 is not ready at build time, gate `push` behind
  a manual "I have paused dispatch" checkbox as a stopgap and wire the real signal when #7 lands.
- **Relates to #3 (health board):** the agent re-home board consumes the same per-agent verdict
  data #3 surfaces fleet-wide. Build only the cutover-scoped panel here; do not build #3.
- **Collision files (write coordination):**
  - `web/app/api/agents/heartbeat/route.ts` / `web/lib/jobs/runner-service.ts` — **read only**;
    no edits, so no collision, but any concurrent feature editing `heartbeat`/`claim` should land
    first.
  - `AppSetting` key `agent_migration` — shared with the agents change-URL modal
    (`web/app/agents/actions.ts`, `web/app/api/admin/agent-migration/route.ts`). This feature and
    that modal both write it; they are consistent (both use `{enabled,targetUrl,proofAgentId}`),
    but the cutover console should be the sole driver during the window to avoid two operators
    fighting over the target.
  - No new migration → no `schema.prisma` collision, no Prisma-client regeneration risk.
- **runner/VERSION:** untouched by this feature (S4).

## 7. Open questions for Evan

1. **Old-host lifetime.** How long do we keep the Mac app alive as the re-home "lighthouse" for
   agents that are offline during the cutover (hours? until every agent is green?)? This gates
   when we can decommission the Mac.
2. **Straggler policy.** If a client-network agent is powered off for days, is `confirm` allowed
   via `ackStragglers` (complete with N pending, lighthouse stays up), or must cutover block until
   100% green?
3. **Durable history.** Do you want a `CutoverRun` Prisma table for an auditable record of each
   move, or is the `AppSetting` + `AuditLog` trail enough (default: AppSetting only, no migration)?
4. **DB move mechanics.** Confirm the move is `pg_dump`→`restore.sh`→Azure Postgres (baseline-in-DB
   approach assumes the dump carries the `cutover` AppSetting row). If instead you use Azure DMS /
   logical replication, the baseline must be captured differently (a JSON artifact carried by hand).
5. **Delinea reachability from Azure.** Confirm the Azure host has network egress to Delinea and the
   `DELINEA_*` broker account — the "secrets resolvable from the new host" check depends on it, and
   it is the single most likely thing to differ between LAN and Azure.
6. **Resolvability sample size.** Verify all secrets (slow, ~hundreds of Delinea round-trips) or a
   per-client sample + all GA/app-reg secrets (fast, default)? Full is safer but may take minutes.
7. **App public URL vs migrate target.** Confirm `APP_PUBLIC_URL` (notification links) is set on
   Azure independently — the cutover console warns if it still points at the LAN IP after `confirm`.

## 8. Ordered implementation task breakdown (overnight subagent)

1. **`web/lib/jobs/cutover.ts`** — `CUTOVER_KEY`, `CutoverState`, `normalizeCutover`, `canAdvance`,
   `nextPhase`, `agentRehomeVerdict`, `fleetRehomeSummary`. Pure, no I/O. *(TDD: write
   `cutover.test.ts` first.)*
2. **`web/lib/jobs/cutover-db.ts`** — `DbBaseline`, `DbVerifyResult`, `computeBaseline(db)`,
   `verifyDbMove(db, baseline, delineaCfg, sampler)`, `secretRefHash`, `ok` derivation. Delinea
   calls go through the injectable `Fetcher` seam. *(TDD: `cutover-db.test.ts` first.)*
3. **`web/app/api/admin/cutover/route.ts`** — POST `{action, azureUrl?}`, guard `settings.manage`,
   `claimAppSetting` transitions, audits (`cutover.stage|push|confirm|rollback|ack_stragglers`),
   reuse the agent-migration URL validator, write `agent_migration` on `push`/`rollback`.
4. **`web/app/api/admin/cutover/db-verify/route.ts`** — guard `settings.manage`; call
   `computeBaseline` (on Mac path) / `verifyDbMove` (on Azure path); persist onto `cutover.dbVerify`.
5. **`web/app/cutover/_lib/loader.ts`** — read `cutover` + `agent_migration`, reuse agent VM
   queries, compute verdicts + summary, live-reachability check of `oldUrl` (for the rollback
   button). `force-dynamic`.
6. **`web/app/cutover/_components/cutover-view.tsx`** — client component: phase stepper, agent
   board (reuse `migrateStatus`), DB-verify panel, action buttons; live-poll while in
   `pushing|verifying-*`. Host design system.
7. **`web/app/cutover/page.tsx`** — thin server page rendering the loader + view; `metadata.title`.
8. **Nav + guard** — add a `/cutover` entry visible to `settings.manage`; confirm middleware lets
   the admin routes through.
9. **Changelog entry** — one file per entry under `web/lib/changelog/entries/` (Eastern time,
   15-min boundary), registered in `_registry.ts`.
10. **Verification** — run the new tests + existing agent/migration/backup/self-heal suites; do the
    canary dress rehearsal against a second URL of the same app; leave a note that #7's drain signal
    is stubbed behind a manual checkbox until #7 lands.
