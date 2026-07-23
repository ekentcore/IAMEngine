# Fleet health dashboard + proactive alerting — design spec

**Date:** 2026-07-22
**Feature:** #3 of the Azure-cutover finalization batch
**Status:** design only (no code in this change)
**Author:** Claude (design agent)

---

## 1. Purpose & gap

Tomorrow the app moves to Azure. On day one the Remote Support team needs **one board that
answers "are we healthy?"** without inferring it from individual case/job pages. Today the
signals exist but are scattered and mostly pull-based:

- `/health` (`app/health/_components/health-view.tsx`) — live integration credential checks
  (incl. DB `SELECT 1`), but nothing about agents, queue, or backups.
- `/health/connections` — per-client/system connection-test results, not fleet posture.
- `/agents` — a rich per-agent table (online/version/in-flight phase/migration), but no
  roll-up and no queue/backup/DB view.
- Alerting exists only for **per-event** conditions already wired into `fireNotification`
  (case/step failures, auto-stop, conn-test sweep failures, cred expiry, backup-run failure).
  There is **no proactive alert** for "an agent went dark", "the queue is backing up",
  "failures are clustering", or "a backup silently stopped happening".

The gap is (a) a single aggregated board and (b) proactive alert rules for standing
conditions. This is also feature #2's ("are all agents re-homed after the Azure move?")
primary signal — so the **per-agent online state + build-version columns must be
first-class** on this board.

**Hard constraint:** this feature is a *reader*. It reads agent/job/backup state and never
modifies `claim()` or the job state machine (S-seam below). Every reclaim/standby decision
stays owned by `runner-service.ts`; we re-derive the *same* predicates read-only for display.

---

## 2. Current state (file:line)

**Agent model** — `web/prisma/schema.prisma:257-313`
- `scope` (`central` = `clientId null` / `client_network`), `clientId`, `name`
- `version` = content-hash **build id** (canonical "on current code?"), `semver` = display
  release string, `capabilities` (Json), `priority` (lower = higher; standby rule),
  `lastSeenAt`, `bootAt` (uptime), `enabled`, `deletedAt` (trash)
- migration fields: `currentAppUrl`, `migrateRequested/DeliveredAt`, `migratedAt`,
  `migrateError` — the #2 re-homing signal.

**Online / lease / stale constants**
- `AGENT_ONLINE_MS = 90_000` — the one shared definition, `web/lib/runner/reachability.ts:17`
  (mirrored as inline `90_000` literals in `runner-service.ts:571`, `cases/repository.ts:657`,
  `cases/run-report.ts:632`, `agent-updates` cooldown `runner-service.ts:408`).
- `LEASE_MS = 10*60*1000` — `web/lib/jobs/runner-service.ts:125` (stale dispatched-lease reclaim).
- `PROGRESS_STALE_MS = 20*60*1000` — `runner-service.ts:128` (wedged "running" job).
- `MAX_PROGRESS_RECLAIMS = 1` — `runner-service.ts:129`.
- Wedged/stale detection already computed inside `claim()` — `runner-service.ts:583-635`
  (we reuse the **predicates** read-only; we do NOT call this path).

**Job model + state machine** — `web/prisma/schema.prisma:460-494`
- `status` (`pending→dispatched→running→succeeded/failed/skipped`), `mode`, `sequence`,
  `assignedAgentId`, `progress` (`[{ts,phase}]`), `progressAt`, `startedAt`, `finishedAt`,
  `request` (carries `autoStopped`, `progressReclaims`, `validateOnly`, `singleRun`).
- Indexes already cover the reads we need: `@@index([status, mode])`,
  `[status, startedAt]`, `[status, progressAt]`, `[assignedAgentId]`.

**Version skew**
- `runnerBuildId()` (SHA-256, 12 hex) + `runnerVersion()` (semver from `runner/VERSION`) —
  `web/lib/runner/bundle.ts:99-121`.
- `agentBuildIsCurrent(reported, served)` — `web/lib/jobs/agent-updates.ts` (used in the
  heartbeat auto-update path, `runner-service.ts:411`).
- Stale-build claim refusal — `runner-service.ts:642-647`.

**Alerting plumbing (the seam to EXTEND)**
- `fireNotification(e)` — `web/lib/notifications/sender.ts:234-250`. Respects the master
  switch `settings.enabled` and the per-event toggle `settings.events[e.event]`; audits
  `notification.sent`; **never throws**.
- Event registry — `web/lib/notifications/types.ts`: `NotifEvent` union (line 11),
  `NOTIF_EVENTS` list (14-29, drives the Settings toggle rows), `DEFAULT_NOTIFICATIONS`
  (65-75). `credExpiryDays` already lives here (52-53) as a threshold precedent.
- Master switch: `NOTIFICATIONS_SETTING_KEY = "failure_notifications"` (types.ts:6). Test
  sends bypass it (per PR #60 / memory `chat-alerts-master-switch.md`).
- Storm-guard precedent — `planConnNotifications()` in `web/lib/jobs/conn-sweep.ts:67-74`
  (≤3 individual, more → one digest).

**Periodic-task pattern (no cron — rides heartbeats)**
- `heartbeat()` chains fire-and-forget sweeps — `runner-service.ts:467-476`:
  `sweepProcurementWatches`, `sweepServiceNowIntake`, `sweepConnTests`, `sweepDbBackup`.
- Each sweep: in-process `TICK_EVERY_MS` throttle **then** a durable AppSetting throttle
  claimed race-safely via `claimAppSetting` — `web/lib/settings.ts:21-34`.
- Event-driven detection + tick-flush + `failNotifiedAt`/`pendingNotifyAt` dedupe —
  `conn-sweep.ts:155-201`; `sweepDue`/`diffConnOutcome` pure classifiers (46-62).

**Backups** — `web/lib/jobs/db-backup.ts`
- `DB_BACKUP_KEY="db_backup"`; `DbBackupSetting.lastResult`/`lastStartedAt`;
  `backupDue(s,now)` (93-102); `dbBackupStatus(raw)` projection (78-88);
  `backupFailed` notification fired on a failed run (229-236). Note the doc header:
  "if no runner is heartbeating, the in-app backup has no clock" — the standalone launchd
  layer covers that gap.

**DB-up check** — `web/lib/health/checks.ts:63` (`db.$queryRaw\`SELECT 1\`` + client count),
served by `app/api/health/route.ts`.

**UI patterns**
- Shared loader pattern `app/<page>/_lib/loader.ts` + `_components/*-view.tsx` + `v2`/`v3`
  page variants — see `app/agents/_lib/loader.ts` (agent VM assembly incl. `activeStateForAgent`
  in-flight phase logic, lines 62-72) and `app/health/connections/_lib/loader.ts`.
- Client-side polling of a JSON route with `cache:"no-store"` — `health-view.tsx:24-38`.
- Nav — `app/_components/nav.tsx`: `PRIMARY` has `/agents` (19); Reference group has
  `/health` (33). `menuGroups(...)` builds the "More" menu.

---

## 3. Design

### 3.1 Board: route, layout, scope

**Route:** `/health/fleet` (additive under the existing Health area, sibling to
`/health/connections`), with `v2`/`v3` page variants per the house pattern. Files:
`app/health/fleet/page.tsx`, `_lib/loader.ts`, `_components/fleet-view.tsx`, `v2/page.tsx`,
`v3/page.tsx`, plus the poll route `app/api/health/fleet/route.ts`.

**Nav:** add `["/health/fleet", "Fleet health"]` to the Reference group in
`app/_components/nav.tsx` (open question: promote to `PRIMARY` for day-one visibility).

**Scope/permission:** this is infra-wide (crosses all clients), so gate on a global role
(`audit.view` or `global_admin` — open question). Unlike `/agents` it is **not** per-client
scoped; the central runner and cross-client queue counts are the whole point.

**Design system (S5):** flat, minimal borders, sentence case, no gradients — reuse the
existing badge/table styling from `health-view.tsx`/agents view. The board is a stack of
compact sections, each a table or a KPI row:

1. **Header strip** — one-line verdict ("Fleet healthy" / "N conditions need attention") +
   currently-firing alerts (read from `alerts.state`, §3.4) + last-refreshed time + a manual
   refresh button (mirrors `health-view.tsx`).
2. **Agents** (the #2 re-homing panel) — one row per enabled, non-trashed agent:
   - **online state**: `online` (lastSeenAt within `AGENT_ONLINE_MS`), `at-risk`
     (between 90s and the offline threshold), `offline` (older than the threshold), plus
     "stuck on `<phase>`" when it's the assigned agent of a wedged in-flight job (reuse
     `activeStateForAgent` logic).
   - `lastSeenAt` age, uptime (`bootAt`).
   - **build/version skew** (first-class): `semver` + short build hash, and a
     `buildCurrent` badge = `agentBuildIsCurrent(version, runnerBuildId())`. Header shows
     "served build `<hash>` · X/Y agents current".
   - **standby vs active**: read-only re-derivation of `shouldStandBy(priority, onlinePeerPriorities)`
     from `runner-logic` — show "active" / "standby (behind `<peer>`)".
   - scope (central / client + clientName), capabilities.
   - **migration** (#2 signal): `currentAppUrl` vs the migration target
     (`AGENT_MIGRATION_KEY`), `migratedAt`, `migrateError` — so "are all agents re-homed to
     the Azure URL?" is answerable at a glance.
3. **Queue** — counts of api jobs by status (`pending`/`dispatched`/`running`) on live cases
   (case not `completed`/`failed`, `deletedAt null`, not paused — same filter as the claim
   candidate query, read-only); **oldest-pending age**; **wedged** = `running` with
   `progressAt` (or `startedAt`) older than `PROGRESS_STALE_MS` (the exact `claim()` wedged
   predicate, `runner-service.ts:603-619`, computed read-only); **stale dispatched** =
   `dispatched` with `startedAt` older than `LEASE_MS`; **auto-stopped in last 24h**
   (`request.autoStopped`).
4. **Recent failures** — job failures in the last `failureWindowMinutes` and last 24h,
   grouped by client/system, with the top offenders.
5. **Backups** — `dbBackupStatus()`: last result ok/failed + age of `lastStartedAt`, next-due
   (`backupDue`), and a **stale** flag when the newest success is older than
   `backupMaxAgeHours`.
6. **DB + integrations** — DB up (reuse `SELECT 1` from `health/checks.ts`) + a compact
   "N/M integrations healthy" roll-up (reuse `runHealthChecks()`), linking to `/health` for
   detail. (DB-down is a **board-only** signal — see §3.4 on why it is not an alert rule.)

### 3.2 Aggregation loader

`app/health/fleet/_lib/loader.ts` exports `loadFleetHealth()` returning a plain VM. **Every
signal is a query-time read** — no stored board state, no heartbeat dependency to *view* the
board. It performs a handful of independent queries (agents, job status counts via
`groupBy`, oldest-pending, wedged/stale via the indexed predicates, recent-failure `groupBy`,
`dbBackupStatus`, `runnerBuildId()`, migration setting) and shapes VMs. The pure roll-up
(counts/classification) lives in `web/lib/fleet/health.ts` so it unit-tests without Prisma.

**Live-ish refresh:** `fleet-view.tsx` is a client component that renders the SSR loader
output first, then polls `GET /api/health/fleet` (which calls the same `loadFleetHealth()`)
every ~20-30s with `cache:"no-store"` — the `health-view.tsx` pattern. No websockets.

### 3.3 Alert-rule model + which conditions

Extend the existing plumbing (S6) — **no second alerting system**. Add four `NotifEvent`s to
`web/lib/notifications/types.ts` (union + `NOTIF_EVENTS` + `DEFAULT_NOTIFICATIONS.events`),
so they automatically gain a Settings toggle row and honor the master switch:

| Rule | New `NotifEvent` | Condition (query-time) | Cardinality |
|---|---|---|---|
| Agent offline | `agentOffline` | enabled, non-trashed agent, `lastSeenAt` older than `agentOfflineMinutes` | per-agent (storm-guarded) |
| Queue backlog | `queueBacklog` | claimable pending api-job depth ≥ `queueDepth` **and** oldest-pending age ≥ `queueBacklogMinutes` (sustained, so a normal burst doesn't page) | global |
| Repeated failures | `repeatedFailures` | ≥ `failureCount` job failures within `failureWindowMinutes` | global (+per-client in the digest body) |
| Backup stale | `backupStale` | newest successful backup older than `backupMaxAgeHours` (covers "silently stopped", distinct from the existing `backupFailed` which only fires on an actual failed run) | global |

**Not an alert rule — DB down.** Alerting on DB-down from a DB-backed sweep is self-defeating
(no DB → the sweep can't read config or state or deliver). The board shows it; true DB-down is
covered by external uptime monitoring and the standalone launchd backup layer noted in
`db-backup.ts`. Documented so nobody "adds the obvious missing alert" later.

**Delivery reuse:** every rule calls `fireNotification({ event, title, detail, at, url, … })`.
Routing, channel fan-out, master switch, per-event toggle, and audit are all the existing
`sender.ts` path unchanged. `agentOffline`/`repeatedFailures` can carry `clientName` +
`restricted` + `override` for per-client routing when the subject is a single client, exactly
like the conn-sweep failures.

### 3.4 Evaluation cadence + dedupe/cooldown

**Cadence — a heartbeat-driven sweep, because there is no cron.** Add one fire-and-forget
line to the `heartbeat()` sweep chain (`runner-service.ts:~476`):
`void sweepFleetAlerts(db).catch(() => {})`. New module `web/lib/jobs/fleet-alerts.ts` mirrors
`conn-sweep.ts`/`db-backup.ts` exactly:

- in-process `TICK_EVERY_MS` (~60s) guard before any DB work;
- read the `alerts` thresholds + `failure_notifications` settings; if the master switch is
  off, skip;
- **claim the tick** via `claimAppSetting("alerts.state", expected, next)` so, under many
  concurrent heartbeats, exactly one instance evaluates and writes per tick;
- evaluate each rule's condition with **query-time reads** (the same reads the board uses),
  compare against stored dedupe state, fire, persist state.

**Dedupe — deadline-read-at-query-time, not a maintained counter** (memory lesson,
`feature-request-numbering-autohide.md`). State lives in AppSetting **`alerts.state`** (S3
namespace) as a small keyed map — no new table, no migration for v1:

```
type AlertState = { [ruleKey: string]: { firedAt: string /*ISO*/ } }
// ruleKey: "agentOffline:<agentId>" | "queueBacklog" | "repeatedFailures" | "backupStale"
```

Fire a rule/subject only when the condition is **true now** AND
(`firedAt` absent OR `now - firedAt > cooldownMinutes`). When the condition is **false now**,
**delete** its key — so the next occurrence re-alerts immediately (a recovered-then-recurring
agent pages again; a still-offline agent re-pages only every `cooldownMinutes`). This is the
same shape as conn-sweep's `failNotifiedAt` cleared-on-recovery, expressed as a deadline read
rather than a sweep-maintained tally. Recovery itself is silent by default (matches
conn-sweep; open question whether operators want a "recovered" note).

**Storm-guard (critical for the Azure cutover):** a bad DNS/URL migration can knock *many*
agents offline at once. Reuse the `planConnNotifications` shape for `agentOffline`: ≤3 newly-
offline agents → individual notifications (each with its client's routing); more → **one
digest** to the default destination ("N agents offline: `<sample>`"). Prevents a 200-message
storm on day one.

### 3.5 Threshold configuration (S3)

Thresholds live in a dedicated AppSetting key **`alerts`** (S3: `alerts.*`), with a
`normalizeAlerts(raw)` defaults function (the `normalizeDbBackup`/`normalizeConnSweep`
pattern):

```
type AlertSettings = {
  agentOfflineMinutes: number;    // default 15  (must exceed the 90s online window)
  queueDepth: number;             // default 25
  queueBacklogMinutes: number;    // default 15
  failureCount: number;           // default 5
  failureWindowMinutes: number;   // default 60
  backupMaxAgeHours: number;      // default 26  (one nightly + slack)
  cooldownMinutes: number;        // default 120 (re-fire suppression per rule/subject)
}
```

The **enable/disable per rule** stays in `failure_notifications.events` (the existing toggle
rows), so the Settings UI gains four checkboxes automatically from `NOTIF_EVENTS`; the
**numeric thresholds** get a new "Alert thresholds" card in Settings writing the `alerts`
key. This split (toggle in `failure_notifications`, numbers in `alerts`) is the exact S3+S6
seam and matches how `credExpiryDays` already sits beside its `credExpiring` toggle.

---

## 4. Shared-seam conformance

| Seam | Requirement | This design |
|---|---|---|
| **S6** | Extend `failure_notifications`, don't fork | New events added to the existing `NotifEvent`/`NOTIF_EVENTS`/`DEFAULT_NOTIFICATIONS`; all delivery via `fireNotification`. No new sender/router. |
| **S3** | AppSetting keys under `alerts.*` | Thresholds in `alerts`; dedupe state in `alerts.state`. Per-rule enable stays in `failure_notifications.events`. |
| **S5** | New page additive; reuse loader + design system | `/health/fleet` additive under existing Health area; `_lib/loader.ts` + `_components` + `v2`/`v3`; flat/minimal/sentence-case, reused badge styles. |
| **Read-only / #2 signal** | Never modify `claim()`; per-agent online + build columns first-class | We only *read* agent/job/backup state and re-derive `claim()` predicates read-only. `claim()` untouched. Agents panel makes online-state + build-current + migration columns primary. |

**Shared files touched (all additive):**
- `web/lib/notifications/types.ts` — add 4 events to the union, `NOTIF_EVENTS`, and
  `DEFAULT_NOTIFICATIONS.events`. *(shared with the whole notification subsystem — additive,
  no field renamed.)*
- `web/lib/jobs/runner-service.ts` — **one line** in the `heartbeat()` sweep chain
  (`void sweepFleetAlerts(db)`). Hot path → must be throttled + fire-and-forget like its
  siblings. **`claim()` and the state machine are not touched.**
- Settings page/loader/actions (`app/settings/*`) — new "Alert thresholds" card writing
  `alerts`; the four event toggles appear automatically from `NOTIF_EVENTS`.
- `app/_components/nav.tsx` — one nav entry.

**New files:** `web/lib/jobs/fleet-alerts.ts` (sweep + pure evaluators),
`web/lib/fleet/health.ts` (pure aggregation), `app/health/fleet/{page,v2/page,v3/page}.tsx`,
`app/health/fleet/_lib/loader.ts`, `app/health/fleet/_components/fleet-view.tsx`,
`app/api/health/fleet/route.ts`.

`web/lib/runner/reachability.ts` (`AGENT_ONLINE_MS`) and `bundle.ts` (`runnerBuildId`) are
**imported unchanged** — the online window and served-build id have exactly one definition.

---

## 5. Testing

Follow the app's `node:test` unit style (see `reachability.test.ts`), keeping logic pure so
it tests without Prisma or a live server:

- **Board roll-up** (`web/lib/fleet/health.ts`): agent online-state classification against
  `AGENT_ONLINE_MS`/threshold boundaries; wedged/stale predicates match the `claim()` cutoffs;
  build-current counting; standby re-derivation matches `shouldStandBy`.
- **Alert evaluators** (`fleet-alerts.ts`): each condition true/false at its threshold
  boundary; `queueBacklog` requires *both* depth and sustained-age; `backupStale` age math;
  `repeatedFailures` window count.
- **Dedupe/cooldown:** fires once, suppressed within cooldown, re-fires after cooldown,
  re-fires immediately after recovery-then-recurrence, key deleted on recovery.
- **Storm-guard:** ≤3 offline → individual; >3 → single digest (mirror
  `planConnNotifications` tests).
- **Sweep wiring:** in-process throttle skips sub-`TICK_EVERY_MS`; `claimAppSetting` makes one
  of two concurrent ticks win; `fireNotification` never throws through the sweep.
- **Manual verify** (worktree dev server + minted session, memory `web-dev-verify-recipe.md`):
  render `/health/fleet`, force an agent offline (stale `lastSeenAt`), confirm the board flips
  and the `agentOffline` alert fires to a Test channel; confirm the master-switch OFF path
  stays silent while the board still shows the condition.

---

## 6. Sequencing & dependencies

1. `web/lib/notifications/types.ts` — add the four events (unblocks everything; harmless alone).
2. `web/lib/fleet/health.ts` — pure aggregation + its tests.
3. `app/health/fleet/*` + `app/api/health/fleet/route.ts` + nav — **the board ships first and
   standalone**; it's read-only and the highest day-one value. Alerting can follow.
4. `web/lib/jobs/fleet-alerts.ts` (+ `normalizeAlerts`, dedupe) + tests.
5. One-line wire into `heartbeat()` sweep chain.
6. Settings "Alert thresholds" card.

**Dependencies / coordination:**
- No schema migration required for v1 (state in AppSetting). If per-agent columns are
  preferred later (§7), that's an additive migration.
- **Feature #2 (re-homing):** the Agents panel's online + `buildCurrent` + migration columns
  are #2's signal — build these first-class and keep the VM shape stable for #2 to consume.
- **Azure cutover reality:** after the checkout moves, `runnerBuildId()` can shift if the
  served tree differs (memory `runner-selfupdate-served-from-app-disk.md`) — the build-skew
  column is exactly the surface that catches "agents pinned to an old build". The
  `agentOffline` storm-guard matters most on cutover day.
- Alerts ride heartbeats: if the whole fleet is down, no sweep runs — the board still renders
  (query-time) but alerts won't fire. Accept + document (same limitation as every sweep;
  external uptime monitoring is the backstop). Note this in the board footer.

---

## 7. Open questions for Evan

1. **Board placement:** `/health/fleet` (proposed) vs a top-level `/fleet`, and should it be
   promoted to the **primary** nav bar for day-one visibility rather than the "More" menu?
2. **Who sees it:** `audit.view` (like `/health/connections`) or restrict to
   `global_admin`/`super_admin`? It is deliberately cross-client (not client-scoped).
3. **Dedupe state store:** AppSetting `alerts.state` JSON blob (proposed, no migration) vs a
   first-class `Agent.offlineAlertedAt` column + a small `alerts.state` for the global rules
   (mirrors conn-sweep's `failNotifiedAt` exactly, at the cost of a migration). OK with the
   blob for v1?
4. **Thresholds:** are the defaults sane (offline 15m, queue depth 25 / 15m sustained, 5
   failures / 60m, backup stale >26h, 120m cooldown)?
5. **Repeated-failures scope + routing:** global only, or also per-client alerts? The digest
   goes to the **default** destination like conn-sweep — confirm that's the wanted routing.
6. **Recovery notices:** stay silent on recovery (conn-sweep behavior), or send a "recovered"
   note when an agent comes back / the queue drains?
7. **DB-down:** confirm board-only (no alert rule), relying on external uptime + the launchd
   backup layer.
8. **Standby agents:** a lower-priority standby still heartbeats, so "offline" = genuinely
   down — treat it identically to an active agent for `agentOffline`? (Proposed: yes.)
9. **Alert history:** is chat + the existing `notification.sent` audit row enough, or do we
   want an in-app alert-history table/page?

---

## 8. Ordered implementation task breakdown

1. **Events** — add `agentOffline`, `queueBacklog`, `repeatedFailures`, `backupStale` to
   `NotifEvent`, `NOTIF_EVENTS` (with labels), and `DEFAULT_NOTIFICATIONS.events` in
   `web/lib/notifications/types.ts`.
2. **Pure aggregation** — `web/lib/fleet/health.ts`: agent online/stale/offline classifier
   (reusing `AGENT_ONLINE_MS`), build-current count (`runnerBuildId` + `agentBuildIsCurrent`),
   standby re-derivation, queue counts, wedged/stale predicates, recent-failure roll-up,
   backup staleness. Unit tests at each boundary.
3. **Loader + API** — `app/health/fleet/_lib/loader.ts` (`loadFleetHealth()`) and
   `app/api/health/fleet/route.ts` (calls the loader, `force-dynamic`, auth-guarded).
4. **Board UI** — `fleet-view.tsx` (client, SSR-first + ~25s poll) and `page.tsx` +
   `v2`/`v3`; nav entry in `app/_components/nav.tsx`. **Ship here** — board is complete and
   read-only.
5. **Thresholds** — `AlertSettings` type + `normalizeAlerts` in `fleet-alerts.ts` (or a small
   `web/lib/jobs/alerts-settings.ts`), AppSetting key `alerts`.
6. **Alert sweep** — `sweepFleetAlerts(db)` in `web/lib/jobs/fleet-alerts.ts`: in-process
   throttle → read settings/master-switch → `claimAppSetting("alerts.state")` → evaluate rules
   (query-time) → deadline-read dedupe/cooldown → `fireNotification` (with the
   `planConnNotifications`-style digest for `agentOffline`) → persist state. Tests for
   evaluators + dedupe + storm-guard.
7. **Wire the sweep** — one `void sweepFleetAlerts(db).catch(()=>{})` in the `heartbeat()`
   sweep chain (`runner-service.ts:~476`). No other change to that file.
8. **Settings card** — "Alert thresholds" in `app/settings/*` writing `alerts`; verify the
   four event toggles render from `NOTIF_EVENTS`.
9. **Verify** — unit suite green; manual dev-server walk-through (§5); changelog entry.

---

### Summary

Ship a read-only `/health/fleet` board that aggregates, at query time, every fleet signal the
team currently has to hunt for — per-agent online/at-risk/offline + last-seen + build-skew
(`runnerBuildId` vs `agentBuildIsCurrent`) + standby/active + scope + migration state (the
#2 re-homing signal, made first-class), plus queue depth/oldest-pending/wedged/stale jobs,
recent-failure clustering, backup freshness, and DB/integration health. Proactive alerting is
**added to the existing `failure_notifications` plumbing** (S6): four new `NotifEvent`s
(`agentOffline`, `queueBacklog`, `repeatedFailures`, `backupStale`) fired by a new
heartbeat-chained `sweepFleetAlerts` that evaluates conditions at query time and dedupes with
a **deadline-read cooldown** in AppSetting `alerts.state` (memory lesson, not a maintained
counter), thresholds in AppSetting `alerts` (S3), per-rule enable in the existing settings
toggles. DB-down is deliberately board-only (a DB-backed sweep can't alert on its own DB).
Riskiest open question: **dedupe-state store** — AppSetting JSON blob (zero migration, proposed)
vs a first-class `Agent.offlineAlertedAt` column mirroring conn-sweep's `failNotifiedAt`.
Shared files touched (all additive): `web/lib/notifications/types.ts` (4 events), a one-line
sweep wire in `web/lib/jobs/runner-service.ts` `heartbeat()` (claim untouched),
`app/settings/*` (threshold card), `app/_components/nav.tsx` (one link); everything else is new
files (`fleet-alerts.ts`, `fleet/health.ts`, the `/health/fleet` page + API).
