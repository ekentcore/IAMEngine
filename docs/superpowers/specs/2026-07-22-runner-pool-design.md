# Runner pool on one machine — design spec

Feature #1 of the finalization batch. Run **N runner processes on one box** for (a)
redundancy/failover, (b) peers restarting a dead peer, and (c) **parallel job execution**.

- Status: design only. No code in this doc.
- Shared seam: **S4 (runner/\*)** — see `docs/superpowers/specs/2026-07-22-finalization-seams-and-sequencing.md`.
- Depends on **#4 (per-(clientId,systemKey) in-flight governor)** for safe parallelism; composes with **#7 (drain)**.
- Date: 2026-07-22. Runner build at time of writing: `1.94.0` (`runner/VERSION`).

---

## 1) Purpose & gap — what's already built vs. the real new work

Most of the redundancy story already exists. Reading the code, three of the four things a
"pool" usually has to invent are already in the tree:

| Capability | Already built | Where |
|---|---|---|
| **Failover / stand-by** | `Agent.priority` (LOWER = higher precedence) + `shouldStandBy()` enforced in `claim()`. A strictly-higher-priority peer of the same scope forces a runner to idle; **equal-priority same-scope peers both claim and load-balance**. | `web/prisma/schema.prisma:271-275`, `web/lib/jobs/runner-logic.ts:76-83`, `web/lib/jobs/runner-service.ts:566-576` |
| **Race-safe concurrent claim** | Atomic `updateMany where { id in eligible, status:"pending" }` → only rows still pending flip; the follow-up `findMany where assignedAgentId = agent.id` returns only the rows **this** agent won. Two agents racing never both win the same row. | `web/lib/jobs/runner-service.ts:860-871` |
| **Restart-the-dead-one** | OS supervisors (`install-launchd.sh` KeepAlive, `install-task.ps1` 1-min re-trigger, `install-systemd.sh` Restart=always), the standalone `Keep-IamRunnerAlive.ps1`, and the pure decision helper `Get-CtgKeepAliveAction` (restart if process gone OR heartbeat present-but-stale). Server also reclaims stale leases. | `runner/Keep-IamRunnerAlive.ps1`, `runner/lib/Coretelligent.Watchdog/Coretelligent.Watchdog.psm1:62-72`, `runner-service.ts:578-595` |
| **Self-update / restart / migrate** | `Update-CtgRunner` (re-pull manifest → relaunch), `Restart-CtgRunner`, `Invoke-CtgMigrate`, `Invoke-CtgRelaunch` (supervised = exit-and-let-supervisor-relaunch). | `Start-IamRunner.ps1:2050-2199` |

**So the pool is NOT new failover logic and NOT a new claim protocol.** The genuinely new
work is small and specific:

1. **Give each pool member a DISTINCT `agentId`** (distinct enrollment) at **equal priority
   + same scope/client**, so the *existing* equal-priority load-balancing claim admits them
   as concurrent peers. This is the design crux (§3.2).
2. **Per-member lock.** The single-instance guard (`.runner.lock`, one file per folder,
   newest-PID-wins) currently **evicts** any second runner in the same folder. Members must
   each own a lock keyed by their own `agentId` so they coexist (§3.3).
3. **A tiny pool supervisor** (`Start-IamRunnerPool.ps1`) that spawns/monitors N members and
   peer-restarts a dead one, reusing `Get-CtgKeepAliveAction` (§3.1, §3.5).
4. **Pool-aware self-update** that converges all members to one build without a
   thundering-herd relaunch (§3.6).
5. **`-PoolSize N` install** across the three OS installers (§3.7).

Parallelism itself is *already* correct at the claim layer. What makes parallel **execution**
safe is not in this feature — it is **#4's admission cap** (§3.4). This spec depends on it.

---

## 2) Current state (file:line)

### Poll/claim/execute loop — strictly sequential, on purpose
- `runner/Start-IamRunner.ps1:3187` — `while ($true)` poll loop.
- `:3235` — `POST /api/jobs/claim { agentId, batchSize, version }`.
- `:3237-3509` — `foreach ($job in @($jobs))` executes claimed jobs **strictly sequentially**.
- `:3489-3507` — the `finally` tears down the process-wide connection (`& $handler.Disconnect`
  + `Clear-CtgConnectionSiblings -IncludeSelf`) **between jobs**. The comment cites incident
  **UM0029840 / AADSTS700016**: the `Coretelligent.*` modules hold **one process-wide
  connection per system** (`$script:ConnectedTenant`), and tearing it down at job end is
  "what makes 'each client runs separately' true rather than merely usual."

  => **Parallelism must come from PROCESS isolation** (one process = one PowerShell session =
  its own connections), **never** threads/runspaces inside a runner. This is load-bearing;
  the pool design does not touch the sequential foreach or the teardown.

### Single-instance lock — the thing that must change
- `:3161-3167` — `$script:LockPath = Join-Path $PSScriptRoot '.runner.lock'`; writes `$PID`.
- `:3192-3203` — on each loop, if the lock's PID ≠ mine, **exit 0** (newest PID wins).
  Two runner processes in one folder evict each other today. **The pool needs per-member locks.**

### Identity / enrollment
- Mandatory `-AgentId` param (not self-generated): `Start-IamRunner.ps1:13`.
- Enrollment mints an `Agent` row: `runner-service.ts:317-334` (`enroll`), reached via
  `POST /api/agents { name, enrollToken }` — see the installer at
  `web/app/api/runner/install.ps1/route.ts:163-168`. **Each POST mints a distinct agentId**;
  new agents default to `priority = 100` (`schema.prisma:275`) and inherit the token's
  scope + clientId. That is *exactly* the equal-priority, same-scope, distinct-id condition.

### Failover + atomic claim (needs NO change — confirmed)
- `runner-logic.ts:76-83` — `shouldStandBy(myPriority, onlinePeerPriorities)` returns true
  only if some peer is **strictly** lower-numbered. Equal peers → both proceed.
- `runner-service.ts:562-576` — `claim()` loads the agent, computes online same-`clientId`
  peers (`lastSeenAt` within `ONLINE_MS = 90s`), and stands by only under a strictly-higher peer.
- `runner-service.ts:860-871` — the **atomic claim**: `updateMany({ where: { id: { in:
  eligible }, status:"pending" }, data:{ status:"dispatched", assignedAgentId: agent.id }})`
  then `findMany({ where:{ id:{ in: eligible }, assignedAgentId: agent.id, status:"dispatched" }})`.
  **This is the load-balancer.** Two members with distinct ids each run their own claim; the
  conditional `status:"pending"` flip means a row already flipped by member A is invisible to
  member B's `findMany` (its `assignedAgentId` is A's). No change required.

### Watchdog + supervisors (reused as-is)
- `Coretelligent.Watchdog.psm1:62-72` — `Get-CtgKeepAliveAction(ProcessAlive, Health)` — the
  pure peer-restart decision the pool supervisor will call per member.
- `:12-19` — `Get-CtgHeartbeatPath` already keys the heartbeat file by `agentId`
  (`iam-runner-$AgentId.heartbeat`), so **distinct members already get distinct heartbeat
  files** — no change needed for per-member health.
- `Keep-IamRunnerAlive.ps1:56-75` — `Get-RunnerPid` finds a runner by lock file **or** by
  command line matched on `AgentId` — already per-agent-capable.
- `Start-IamRunner.ps1:2086-2136` — `Invoke-CtgRelaunch`: **supervised** (`RUNNER_SUPERVISED=1`)
  = just `exit 0` and let the supervisor relaunch. This is the seam the pool supervisor uses
  to own relaunches.

### Self-update surface
- `Start-IamRunner.ps1:2050-2079` — `Update-CtgRunner` re-pulls **every** manifest file into
  `$PSScriptRoot` and prunes stragglers (build id = hash of the whole folder). Members sharing
  one folder means **one puller mutates the files the others are running from** → the pool must
  make update a *supervisor-owned, once* operation (§3.6).
- `:2247` `Get-CtgBuildId` / `:3096` `$script:RunnerBuild` — folder-hash build id sent on every
  heartbeat and claim; the app refuses stale builds.

---

## 3) Design

### 3.0 Topology

```
OS supervisor (launchd / systemd / Scheduled Task)   ← supervises ONE thing
        │  KeepAlive / Restart=always / 1-min re-trigger
        ▼
Start-IamRunnerPool.ps1   (the pool supervisor; long-lived, cheap)
        │  spawns + monitors N detached members
        ├── member 0  → Start-IamRunner.ps1 -AgentId <id0>   (own session, own connections)
        ├── member 1  → Start-IamRunner.ps1 -AgentId <id1>
        └── member …  → Start-IamRunner.ps1 -AgentId <idN-1>
```

The OS supervisor keeps the **pool supervisor** alive (not each member). The pool supervisor
keeps the **members** alive. This nests cleanly inside every existing installer: they already
"supervise Start-IamRunner.ps1"; the pool just swaps the supervised target to
`Start-IamRunnerPool.ps1` (§3.7). Each member is a full, unchanged runner process — same
sequential foreach, same per-job connection teardown, same stall watchdog.

### 3.1 Pool supervisor — `Start-IamRunnerPool.ps1` (NEW)

Responsibilities, and only these:

- **Resolve N member identities** (§3.2) → a list of `{ index, agentId, lockPath, heartbeatPath }`.
- **Spawn** each member detached, `RUNNER_SUPERVISED=1`, passing its own `-AgentId`, sharing
  the pool's `-AppUrl` / token / poll / batch. Reuse the exact detached-launch pattern from
  `Keep-IamRunnerAlive.ps1:84-103` (Windows `Start-Process -WindowStyle Hidden`; Unix a
  self-deleting `/bin/sh -c 'exec … >> log'` launcher, per-launch 0700 dir if it carries the token).
- **Monitor loop** (every `-CheckIntervalSeconds`, default 30s): for each member, compute
  `Test-CtgRunnerHealth -Path <member heartbeat>` and whether its PID is alive, then
  `Get-CtgKeepAliveAction -ProcessAlive $alive -Health $health`. On `restart`: kill a
  wedged-but-alive PID (`Stop-Process`, mirroring `Keep-IamRunnerAlive.ps1:77-82`) then respawn
  that one member. **This is peer-restart** — a dead/wedged member is relaunched by the
  supervisor, independent of the others.
- **Propagate control signals.** The supervisor does **not** poll heartbeat itself for
  `update`/`restart`/`migrate`; members already consume those in their own loop
  (`Start-IamRunner.ps1:3229-3232`). The one signal the supervisor must own is **update**
  (§3.6) so the pool converges to one build atomically instead of each member self-pulling into
  a shared folder.
- **Never dispatch, never claim, never touch Delinea.** The supervisor is process-management
  only; it holds no client state, so UM0029840 does not apply to it.

Reuse, don't reinvent: `Get-CtgKeepAliveAction`, `Test-CtgRunnerHealth`, `Get-CtgHeartbeatPath`,
and the detached-launch helper are all already in `lib/Coretelligent.Watchdog` /
`Keep-IamRunnerAlive.ps1`. The supervisor is a thin loop over N members on top of them.

### 3.2 Member identity / enrollment — **the crux**

**Requirement (state it plainly):** each member MUST have a **distinct `agentId`**, all at
**equal `priority`** and the **same scope/clientId**. Then the existing equal-priority
load-balancer (`runner-service.ts:566-576`, `:860-871`) admits them as concurrent peers and
splits the queue across them, race-safe. **Two processes sharing one `agentId` would both flip
and read back the same `assignedAgentId` rows from `findMany` → DOUBLE EXECUTION** of every
claimed job (each job run twice, credentials brokered twice, ServiceNow noted twice). Distinct
ids are not a nicety; they are the correctness boundary of the whole feature.

**Chosen strategy: persisted pre-enrolled pool roster (lazy-enroll-once, reuse thereafter).**

- The pool supervisor keeps a small local roster file in the runner folder, e.g.
  `.runner-pool.json` (git-ignored like `.runner.lock`; excluded from the build hash — extend
  the skip-list in `Update-CtgRunner`/`Get-CtgBuildId`, which already skip `.runner.lock`,
  `.build`, `*.log`): `[{ index:0, agentId:"cmq…" }, …]`.
- On start, for each of the N indices:
  - if the roster already has an `agentId`, **reuse it** (stable identity across restarts →
    no orphaned `Agent` rows piling up on the Agents page);
  - else **enroll one** via the existing `POST /api/agents { name:"<host> pool #<index>",
    enrollToken }` (`route.ts:165`, `runner-service.ts:317`), capture `id`, persist to the roster.
- New agents inherit `priority = 100` (default) and the token's scope + clientId → the
  equal-priority same-scope condition holds **with zero web changes**.

Why persisted+lazy over the alternatives:
- *Self-generate ids client-side* — rejected: `-AgentId` is deliberately server-minted
  (`route.ts:165`), and a fabricated id fails `db.agent.findUnique` in `claim()` (`:562-563`,
  404 "unknown agent").
- *Enroll fresh every boot* — rejected: leaks a new `Agent` row on every relaunch; the Agents
  page fills with dead peers and the stale-lease reclaim churns.
- *One shared id + N processes* — **forbidden** (double execution, above).

Naming makes the pool legible on the Agents page (`<host> pool #0..#N-1`). Members appear as
N equal-priority peers of the same scope — which is precisely the load-balancing shape the
failover code was built for.

**Interaction with failover priority:** all members share one priority, so none stands by
against another (`shouldStandBy` needs a *strictly* lower peer). If an operator wants a *second
box* as cold standby behind a pool, they give that box's members a higher priority number
(e.g. pool A = 10, pool B = 20); B idles until every A member is offline. Pool membership and
cross-box failover compose without new logic.

### 3.3 Per-member lock

Today `.runner.lock` is one file per folder (`Start-IamRunner.ps1:3166`) and newest-PID-wins
evicts the older process (`:3196-3201`) — which would make members murder each other.

**Change:** make the lock path **agentId-scoped**. `$script:LockPath = Join-Path $PSScriptRoot
".runner.$AgentId.lock"`. The newest-PID-wins semantics stay **within one agentId** (still
kills a half-landed self-update leftover for *that* member), but two different members no longer
share a lock, so they coexist.

- Keep the eviction logic byte-for-byte otherwise; only the filename gains the `$AgentId`
  segment. This is the one required edit to `Start-IamRunner.ps1` beyond the lock.
- `Keep-IamRunnerAlive.ps1:60-63` reads `.runner.lock` — update its `Get-RunnerPid` to the same
  agentId-scoped name (it already also finds the process by AgentId on the command line, so it
  degrades gracefully). The **pool supervisor** finds members the same way.
- Extend the build-hash skip-list (`Update-CtgRunner:2075`, `Get-CtgBuildId`) so
  `.runner.*.lock` and `.runner-pool.json` never perturb the build id. The current glob is
  `.runner.lock` exactly; broaden to `.runner.*.lock`.

### 3.4 Parallel-execution safety — **depends on #4 (the governor)**

The claim layer already load-balances safely. What it does **not** do is stop two *different
members* from concurrently running work for the **same (clientId, systemKey)** — e.g. two
`m365` jobs for the same tenant. Even though each member has its own process-wide connection
(so no *in-process* session bleed), two simultaneous sessions against one tenant reintroduce
the session/throttle collision class UM0029840 guards against (concurrent app-auth to the same
Graph/EXO tenant, rate limits, half-built objects racing).

**#4 (per-(clientId,systemKey) in-flight ≤ 1 admission cap)** is the guard. `claim()` must ask
#4's admission check whether a given (clientId, systemKey) already has an in-flight job on
another agent, and **exclude those rows from `eligible`** before the atomic flip
(`runner-service.ts:860`). With #4 present: members run *different* (client,system) work truly
in parallel, and same-(client,system) work serializes across the pool — the exact invariant.

**This spec DEPENDS on #4 and does NOT re-implement it.** If a pool is stood up **without #4**:
- Distinct-tenant parallelism is fine (the common case, and a real win).
- But nothing prevents two members from grabbing two jobs for the **same** tenant+system at
  once → the UM0029840 collision returns across processes. **Do not ship `-PoolSize > 1`
  before #4 lands.** The pool supervisor should refuse (or loudly warn) to start >1 member
  when the app reports #4's governor is not active (a capability/heartbeat flag from #4).

### 3.5 Peer restart (redundancy in action)

Two independent layers, both already-built primitives:

1. **Pool supervisor** (§3.1) monitors each member via `Get-CtgKeepAliveAction` and relaunches
   a dead/wedged one within one check interval. This is the "peers restart a dead peer" story —
   though architecturally it's the supervisor, not a sibling member, that does the relaunch
   (cleaner: no election, no split-brain).
2. **Server stale-lease reclaim** (`runner-service.ts:578-595`, `:597-632`) re-queues a dead
   member's in-flight jobs (its `lastSeenAt` goes stale → `assignedAgentId` freed → another
   member claims them). Bounded wedged-"running" reclaim (`:597-632`) fails a deterministically
   hanging step after one retry. **Both already work per-agentId; distinct member ids make them
   apply per member for free.**

If the **pool supervisor itself** dies, the **OS supervisor** relaunches it (§3.7), and on
restart it reconciles: any member whose PID is already alive (found via lock/cmdline) is
adopted, not double-spawned. So a supervisor crash never orphans or doubles members.

### 3.6 Self-update across the pool (converge to one build; no thundering herd)

Problem: `Update-CtgRunner` pulls the whole manifest into the **shared** `$PSScriptRoot` and
relaunches the caller. If each member independently reacted to `heartbeat.update`, N members
would pull the same files concurrently into one folder (races, half-written files) and relaunch
in a stampede, with a window where the pool runs **mixed builds**.

**Design: the supervisor owns the update; members yield.**

- Members keep consuming `heartbeat.update` in their own loop **only to trigger a clean exit**
  when the supervisor tells them to (see below) — they do **not** pull. Concretely: when the
  pool supervisor decides to update, it (1) pulls once via the existing `Update-CtgRunner` file
  logic (or an extracted `Invoke-CtgManifestPull` helper — same manifest+file+prune code,
  factored so it can run without immediately relaunching), then (2) signals each member to exit
  (send `restart`-style relaunch — supervised members just `exit 0` per
  `Invoke-CtgRelaunch:2088-2090`), then (3) respawns members **staggered** (e.g. 1–2s apart) so
  they don't all cold-start their heavy `Import-Module` at once.
- **Detecting "update available":** the supervisor heartbeats too (or reads the members'
  heartbeat responses) and compares the app's manifest `buildId` to the folder's
  `Get-CtgBuildId`. When they differ and the operator/app requested update, it runs the
  sequence above **once**.
- **Result:** one pull, one converged build, staggered relaunch — no herd, no mixed-build
  window beyond the brief staggered restart. This is the "all members must converge to the same
  build; avoid a thundering-herd relaunch" requirement.

Open sub-question for Evan (§7): whether members should be *fully passive* on update (supervisor
kills+respawns them) or *self-exit on a supervisor-set flag*. Killing+respawn is simplest and
reuses `Stop-Runner`/`Start-Runner`; a member mid-job would be interrupted — but #7 (drain)
gives the graceful path (drain each member first, then update). Prefer: **drain (via #7) →
supervisor pull → staggered respawn.**

### 3.7 Install / uninstall with `-PoolSize N`

The three installers already "supervise `Start-IamRunner.ps1`". Change: **supervise
`Start-IamRunnerPool.ps1`** and thread a pool size through.

- **`install-launchd.sh` / `install-systemd.sh`** — add `POOL_SIZE` (default 1). When >1, the
  supervised `ProgramArguments` / `ExecStart` invoke `Start-IamRunnerPool.ps1 -PoolSize N`
  instead of `Start-IamRunner.ps1`. Everything else (KeepAlive / Restart=always, token in the
  env dict / EnvironmentFile, `RUNNER_SUPERVISED=1`) is unchanged — the supervisor is now the
  supervised process, and it sets `RUNNER_SUPERVISED=1` for the members it spawns.
- **`install-task.ps1`** — add `-PoolSize N`; the Scheduled Task's action targets the pool
  supervisor. The task's 1-min re-trigger + `MultipleInstances=IgnoreNew` keeps the **supervisor**
  alive; the supervisor keeps members alive. The existing `.runner.lock` doubles-guard on the
  supervisor is replaced by a supervisor-level lock (`.runner-pool.lock`) so two supervisors
  can't both manage the same roster.
- **`PoolSize = 1` is the default and is byte-compatible** with today: the supervisor spawns a
  single member = the current single-runner behavior, so nothing regresses for the ~200 existing
  single-agent installs. (Optionally, PoolSize=1 can bypass the supervisor entirely and launch
  the member directly, to keep the simplest deployments identical — decide in §7.)
- **Uninstall** unchanged in shape (bootout / Unregister-ScheduledTask / systemctl disable). The
  supervisor on shutdown stops its members (kill by roster PID). Trashing the pool's `Agent`
  rows is a separate operator action on the Agents page (existing `trashAgent`).

### 3.8 Behavior on partial failure

- **One member crashes / wedges:** supervisor relaunches it (§3.5.1); server reclaims its leases
  (§3.5.2). The rest of the pool keeps working. Net: reduced throughput for one check interval.
- **One member can't enroll** (app down at boot): supervisor retries with backoff; members with
  an already-persisted `agentId` come up regardless. Enrollment is only needed once per index.
- **Supervisor crashes:** OS supervisor relaunches it; it re-adopts live members (§3.5), does not
  double-spawn.
- **Split identity / duplicate id (the nightmare):** guarded structurally — the roster is the
  single source of member ids, and the agentId-scoped lock means even an accidentally
  double-spawned *same-id* member self-evicts on its next loop (`:3196-3201`). So the
  double-execution failure mode cannot silently persist.
- **#4 governor unavailable:** refuse/warn on `-PoolSize > 1` (§3.4).
- **Update mid-flight:** members interrupted only after drain (#7); server re-queues anything
  truly in-flight.

---

## 4) Shared-seam conformance (S4)

**Runner files touched:**
- `runner/Start-IamRunnerPool.ps1` — **NEW.** The pool supervisor.
- `runner/Start-IamRunner.ps1` — **EDIT (small):** (a) agentId-scoped lock path
  `.runner.$AgentId.lock` (§3.3); (b) broaden the build-hash / prune skip-list to
  `.runner.*.lock` + `.runner-pool.json` (§3.3); (c) factor the manifest pull out of
  `Update-CtgRunner` into a reusable `Invoke-CtgManifestPull` the pool supervisor can call once
  (§3.6); (d) honor **#7's drain** in the poll loop — **owned by #7**, this spec only composes
  with it (each member drains independently).
- `runner/Keep-IamRunnerAlive.ps1` — **EDIT (tiny):** agentId-scoped lock name in
  `Get-RunnerPid` (§3.3). Otherwise reused unchanged as the per-box belt-and-suspenders.
- `runner/install-launchd.sh`, `runner/install-systemd.sh`, `runner/install-task.ps1` —
  **EDIT:** `-PoolSize` / `POOL_SIZE`; supervise the pool supervisor (§3.7).
- `runner/VERSION` — **bump ONCE at integration** (currently `1.94.0`; pool is
  backward-compatible → minor bump per `runner-version-policy`). Per S4, do not fight other #-features
  over this file; the integrator bumps it once for the combined runner change.

**Web files touched: none required.** Enrollment reuses `POST /api/agents`
(`runner-service.ts:317`); failover + atomic claim (`runner-service.ts:566-576`, `:860-871`)
are unchanged. (One *optional* nicety: group pooled agents visually on the Agents page by a
shared `poolKey` — deferred, not required for correctness.)

**Dependencies:**
- **#4 (governor)** — hard dependency for safe `-PoolSize > 1` (§3.4). Pool composes by having
  `claim()` consult #4's admission cap; #4 owns that code.
- **#7 (drain)** — composes: each member honors drain independently; the supervisor sequences
  drain→update (§3.6). #7 owns the drain mechanism in `Start-IamRunner.ps1`.

---

## 5) Testing (Pester via `~/.local/pwsh/pwsh`)

Per memory `runner-pwsh-testing.md`: run runner Pester with `~/.local/pwsh/pwsh` (not on PATH);
watch the Pester mocking gotchas. Favor **pure decision helpers** (as the codebase already does
with `Get-CtgKeepAliveAction`, `Test-CtgStalled`) so logic is unit-testable without spawning
processes.

New/extended pure helpers to extract and test:
- `Resolve-CtgPoolMembers` — given `-PoolSize N` + an existing roster → the member list, with
  **which need enrolling**. Tests: N=1 (single member, backward compat), N=3 with 1 pre-enrolled
  (enroll 2, reuse 1), N reduced below roster size (drop extras, don't re-enroll).
- `Get-CtgPoolLockPath` / agentId-scoped lock name — two distinct ids → two distinct paths;
  same id → same path (eviction still fires). Regression: `.runner.lock` glob no longer matches
  the new name in the build-hash skip-list (assert `.runner.<id>.lock` is skipped).
- Reuse `Get-CtgKeepAliveAction` tests to cover the supervisor's per-member decision (already
  unit-tested; add a table over N members: mix of gone / wedged / healthy → correct per-member
  actions).

Integration-ish (mocked HTTP, no real tenant):
- **No double execution:** simulate two members hitting a mocked `claim()` against a shared job
  set; assert each job is returned to exactly one member (mirrors the atomic-flip invariant at
  `runner-service.ts:860-871`). This is the correctness test for the crux.
- Supervisor adopt-on-restart: a live member (lock present, PID alive) is not re-spawned.
- Update convergence: pull runs **once**, members respawned staggered, all report the same
  `buildId`.

Do **not** attempt real parallel M365 execution in tests (needs live tenants + #4); assert the
admission-exclusion at the claim layer with #4 mocked instead.

---

## 6) Sequencing & dependencies

1. **#4 (governor) must land first** (or concurrently, merged before pool ships >1). Without it,
   `-PoolSize > 1` is unsafe (§3.4).
2. Land the **`Start-IamRunner.ps1` edits** (agentId-scoped lock, skip-list, extracted
   `Invoke-CtgManifestPull`) — these are safe and inert at PoolSize=1.
3. Land **`Start-IamRunnerPool.ps1`** + the pure helpers + Pester.
4. Land **installer `-PoolSize`** changes.
5. **VERSION bump once** at S4 integration; deploy runner (NEEDS DEPLOY, per the deploy cadence
   in project memory).
6. Roll out: start the **central cloud runner** as a pool first (highest job volume, no on-prem
   host constraints), validate #4 serialization on same-tenant work, then offer pools to
   high-volume client boxes.

Composes with **#7 (drain)** whenever it lands; pool works without it (update just interrupts +
server re-queues) but is nicer with it (drain-then-update).

---

## 7) Open questions for Evan

1. **PoolSize=1 path:** should PoolSize=1 launch the member *directly* (byte-identical to
   today's single-runner installs) or *always* go through the supervisor (one code path, tiny
   extra process)? Recommendation: always through the supervisor for one code path; it's cheap.
2. **Update model:** supervisor **kills + respawns** members on update (simple, reuses
   Stop/Start), vs. members **self-exit on a supervisor-set flag**? Recommendation: drain (#7) →
   supervisor pull → staggered respawn. Confirm the drain dependency ordering.
3. **How many members** per box by default, and per host class? Central cloud runner vs. a
   client DC (which is doing other work) want different N. Cap N by CPU? Propose default N=3
   central, N=1 (opt-in 2) on client boxes.
4. **Governor coupling (riskiest):** is #4 exposing an admission check `claim()` can call
   **and** a capability flag the pool supervisor can read to refuse `-PoolSize > 1` when #4 is
   absent? The pool's parallel-execution safety is entirely borrowed from #4 — confirm the seam.
5. **Roster location & pruning:** `.runner-pool.json` in the runner folder — acceptable, or
   should member ids live server-side (a `poolKey` on `Agent`)? Local is zero-web-change;
   server-side is tidier for the Agents page. Also: when a box's PoolSize shrinks, do we
   auto-**trash** the now-unused `Agent` rows or leave them for an operator?
6. **On-prem AD pools:** an AD write path binds as SYSTEM-on-a-DC (per `ad-ambient-auth-first`).
   Do we ever want >1 member on a DC, or keep client-network agents at N=1 and only pool the
   central cloud runner? (Leaning: pool central; keep on-prem single unless a client's volume
   justifies it.)

---

## 8) Ordered implementation task breakdown

1. **Extract pure helpers** into `lib/Coretelligent.Watchdog` (or a new
   `lib/Coretelligent.Pool.psm1`): `Resolve-CtgPoolMembers`, `Get-CtgPoolLockPath`. Pester them
   with `~/.local/pwsh/pwsh`.
2. **`Start-IamRunner.ps1` edits:** agentId-scoped `.runner.$AgentId.lock`; broaden build-hash /
   prune skip-list to `.runner.*.lock` + `.runner-pool.json`; extract `Invoke-CtgManifestPull`
   from `Update-CtgRunner` (pull without forced relaunch). Verify PoolSize-1 behavior unchanged.
3. **`Keep-IamRunnerAlive.ps1`:** agentId-scoped lock name in `Get-RunnerPid`.
4. **`Start-IamRunnerPool.ps1` (NEW):** roster resolve + lazy-enroll (`POST /api/agents`);
   detached spawn (reuse the `Keep-IamRunnerAlive` launch helper); monitor loop using
   `Get-CtgKeepAliveAction` per member; adopt-on-restart; supervisor lock `.runner-pool.lock`;
   `#4`-absent guard on `-PoolSize > 1`.
5. **Pool self-update:** supervisor detects build drift, `Invoke-CtgManifestPull` once, staggered
   respawn; members yield (drain via #7 if present).
6. **Installers:** `-PoolSize` / `POOL_SIZE` in `install-launchd.sh`, `install-systemd.sh`,
   `install-task.ps1`; supervise the pool supervisor; keep PoolSize=1 backward-compatible.
7. **Tests:** no-double-execution claim test (mocked), supervisor adopt/respawn, update
   convergence, member-resolution table.
8. **VERSION bump (once, at integration)** + deploy; roll out central runner pool first, validate
   #4 serialization, then extend to high-volume client boxes.

---

## Summary

**Approach:** a thin pool supervisor (`Start-IamRunnerPool.ps1`) runs N *unchanged* runner
**processes** on one box — process isolation, never threads, because each `Coretelligent.*`
session is process-wide and torn down per job (UM0029840). Parallelism is already correct at the
claim layer; the new work is identity, per-member locks, a supervisor, and pool-aware update.
**Identity/enrollment strategy:** a persisted local roster (`.runner-pool.json`) of N
**distinct** server-minted `agentId`s at **equal priority + same scope** — lazy-enrolled once via
the existing `POST /api/agents`, reused across restarts — which is exactly the equal-priority,
same-scope, distinct-id shape the existing atomic claim (`runner-service.ts:860-871`) and
`shouldStandBy` load-balancer already handle **with no web change**. One shared id would cause
double execution; that's the correctness boundary. **Riskiest open question:** the coupling to
**#4 (the governor)** — pool parallelism is only safe because #4 caps in-flight
(clientId,systemKey) ≤ 1 across members; confirm #4 exposes both a claim-time admission check and
a "governor active" flag so the pool refuses `-PoolSize > 1` when it's absent. **Runner files
touched:** NEW `Start-IamRunnerPool.ps1`; EDIT `Start-IamRunner.ps1` (per-agent lock, skip-list,
extracted manifest pull), `Keep-IamRunnerAlive.ps1` (lock name), `install-launchd.sh`,
`install-systemd.sh`, `install-task.ps1` (`-PoolSize`), and `VERSION` bumped once at integration.
