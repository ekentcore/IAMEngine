# Graceful drain / maintenance mode — design spec

Feature #7 of the Azure-cutover finalization set. Design only; no code in this document.

Conforms to the shared-seam contract in
`docs/superpowers/specs/2026-07-22-finalization-seams-and-sequencing.md` (S1–S5). Feature #7
owns **S1(a)** — the FIRST admission gate in `claim()` — and lands before Feature #4
(concurrency caps) layers on.

---

## 1. Purpose & gap

Hosting migrates to Azure tomorrow. The runner fleet polls continuously and claims jobs the
instant they are eligible; a step, once claimed, runs to completion inside the runner's
`foreach` loop against live tenants (Graph, EXO, AD). If the app is cut over mid-flight, any
job that is **dispatched** or **running** at the moment of the switch becomes a torn case: the
runner is executing against a tenant but the brain it reports back to has moved, so the result
post lands nowhere and the case is left half-run — exactly the failure mode the wedged-lease
reclaim (`runner-service.ts` ~597) exists to clean up *after* the fact, but which we want to
*prevent* for a planned cutover.

There is today **no server-controlled way to pause dispatch**. The only levers are:

- Disabling each agent one by one (`agent.enabled = false`) — heavy-handed, per-agent, and it
  *kills* the runner loop (`heartbeat` returns `enabled:false` → runner `break`s, ~3228) rather
  than letting it finish the job in hand.
- Pausing each **case** (`CaseRequest.pausedAt`) — per-case, not fleet-wide, and it doesn't stop
  a job already dispatched.

Neither "finishes the current job then claims nothing new" cleanly, and neither is scoped to a
system or a client for routine maintenance (e.g. "Mimecast API is down, stop dispatching
mimecast steps fleet-wide" or "we're doing tenant maintenance for client X").

**Goal:** a server-side maintenance/drain state that (a) pauses admission in `claim()` so no new
job is handed out, (b) tells each runner via its heartbeat to finish the job in hand and then
idle, and (c) lets an operator observe when the fleet is fully drained (zero `dispatched` +
`running` jobs) so the Azure cutover is safe to pull. Reusable afterwards as a general
maintenance switch, scoped global / per-system / per-client.

---

## 2. Current state (file:line)

All paths relative to `web/` and `runner/` unless noted.

- **`claim()` dispatch** — `web/lib/jobs/runner-service.ts:561`. Gate sequence, in order:
  agent lookup + `enabled` check (`:562`), priority stand-by (`shouldStandBy`, `:576`), stale-lease
  reclaim (`:583`), wedged-running reclaim (`:608`), stale-code guard (`:642`), candidate query
  (`:675`), dependency/secret/host-affinity/setup-gate per-candidate loop (`:775`), atomic
  assignment `updateMany … status:"dispatched"` (`:863`). **Feature #7's gate is the FIRST
  admission decision — it slots in immediately after the `agent` fetch + `enabled` check (~:564),
  before the priority stand-by**, so that a draining agent or a maintenance-scoped candidate is
  excluded before any of the heavier reclaim/candidate work is paid for.
- **Pure claim helpers** — `web/lib/jobs/runner-logic.ts`: `shouldStandBy` (`:76`),
  `isClaimable` (`:47`), `dependencyGateOpen` (`:68`), `setupGateBlocks` (`:111`). New pure
  predicates for #7 belong here (I/O-free, unit-tested in `runner-logic.test.ts`).
- **Heartbeat** — route `web/app/api/agents/heartbeat/route.ts`; service method
  `runner-service.ts:385` (`heartbeat(...)`), whose return type today is
  `{ ok, enabled, update, restart, discover, migrate }` (`:385`). Feature #7 **adds `drain`** to
  that object (S2).
- **Runner honors flags** — `runner/Start-IamRunner.ps1:3227` (`$hb = Invoke-AppApi …`),
  `:3228–3232` (`enabled` / `update` / `restart` / `discover` / `migrate` handling), then
  `:3235` (`claim`), the job `foreach` at `:3237` with per-job teardown `finally` at `:3489`, and
  the sleep-vs-repoll tail at `:3520–3522`.
- **AppSetting** — model `web/prisma/schema.prisma:825`; helpers `web/lib/settings.ts`
  (`getAppSetting` `:5`, `setAppSetting` `:11`, `claimAppSetting` `:21`). Existing keys follow a
  `snake_case` string-id convention (`setup_gate`, `agent_migration`, `agent_auto_update`,
  `conn_test_sweep`, `db_backup`). **S3 mandates our keys live under `maintenance.*`.**
- **RBAC** — `web/lib/auth/permissions.ts`: `Permission` union (`:6`), `ROLE_PERMISSIONS`
  (`:31`), `can()` (`:82`). Guards: `requirePermission()` (`web/lib/auth/guard.ts:27`), used in
  server actions e.g. `web/app/agents/actions.ts:163` for `settings.manage`.
- **Settings UI + server-action toggle pattern** — `web/app/settings/page.tsx` (+ `v2`/`v3`);
  reference toggle action `changeAppUrl` in `web/app/agents/actions.ts:161` (read setting →
  validate → `setAppSetting` → `recordAudit` → `revalidatePath`).
- **Naming-collision note:** the runner ALREADY uses the word "drain" locally — `:3191` comment
  and the `:3520–3522` tail — to mean "keep polling while this cycle still claimed work, only
  sleep once the queue is empty." That is unrelated to maintenance-drain. This spec keeps the S2
  heartbeat field name `drain` (mandated) but everything runner-side is named
  `maintenanceDrain` / `$script:Draining` to avoid confusion with the existing local idiom.

---

## 3. Design

### 3.1 State model (recommended scope: global + per-system + per-client, one setting)

A single AppSetting key holds the whole maintenance state as one JSON object. One key (not
three) keeps reads atomic and toggles race-safe via `claimAppSetting`, and keeps the `claim()`
hot path to **one** settings read.

**Key:** `maintenance.state` (S3-conformant `maintenance.*` namespace).

```
type MaintenanceState = {
  // Global drain: pause ALL dispatch fleet-wide. This is the Azure-cutover switch.
  global: boolean;
  // Per-system pause: dispatch of these systemKeys is paused across every client.
  systems: string[];          // e.g. ["mimecast"] — capped + deduped like adObjects (:503)
  // Per-client pause: dispatch of all systems for these client ids is paused.
  clients: string[];          // client ids
  // Free-text reason shown in the UI + audit + (optionally) the runner console.
  reason?: string;
  // Provenance for the UI banner + audit.
  since?: string;             // ISO — when the current state was entered
  by?: string;                // display actor who last changed it
};
```

Absent key ⇒ treated as `{ global:false, systems:[], clients:[] }` (fail-open: no maintenance).
This mirrors how `setup_gate` and `agent_auto_update` default when unset.

**Why "in maintenance" is a property of the target, but "draining" is a property of the agent.**
The task's S1(a) phrasing — "if the target system/client is in maintenance OR the claiming agent
is draining" — maps cleanly onto this model:

- *Target in maintenance* = the **candidate job's** `systemKey ∈ systems` OR its client
  `∈ clients` OR `global`. Evaluated per candidate inside `claim()`.
- *Agent draining* = `global` is on (every agent drains) — there is no per-agent maintenance flag
  in this design; a global drain is what makes an agent "draining." (A future per-agent drain
  could be added as `agents: string[]` without touching the gate's shape.) Keeping it to `global`
  now matches the actual cutover need and avoids a second toggle surface.

### 3.2 The `claim()` gate (S1(a) — the FIRST admission gate)

New pure helper in `runner-logic.ts`, so it is I/O-free and unit-tested alongside its siblings:

```
export type MaintenanceScope = { global: boolean; systems: string[]; clients: string[] };

// A candidate is admitted only if maintenance does not cover it. Global drain blocks everything.
export function maintenanceBlocks(
  scope: MaintenanceScope,
  candidate: { systemKey: string; clientId: string },
): boolean {
  if (scope.global) return true;
  if (scope.systems.includes(candidate.systemKey)) return true;
  if (scope.clients.includes(candidate.clientId)) return true;
  return false;
}
```

**Placement in `claim()`** (the load-bearing seam detail for Feature #4):

1. Immediately after the `agent` fetch + `enabled` guard (~`:564`), read the state once:
   `const maint = (await getAppSetting<MaintenanceState>(db, MAINTENANCE_KEY)) ?? EMPTY;`
2. **Global short-circuit:** `if (maint.global) return [];` — a full drain claims nothing, and we
   skip every reclaim/candidate query below (cheapest possible path, and correct: during a global
   drain we don't want a claiming agent to *also* trigger stale/wedged reclaims that re-queue
   work). This is the "claiming agent is draining" branch.
3. **Scoped filter:** when not global, the per-candidate loop (`:775`) already has each
   candidate's `systemKey` and, via `caseMetaById`, its `clientId`. Add one line at the top of the
   loop body: `if (maintenanceBlocks(maint, { systemKey: c.systemKey, clientId: meta.clientId })) continue;`
   — placed **before** the dependency/secret/host-affinity checks so a paused target is excluded
   as early and cheaply as possible.

**The seam for Feature #4.** #7's gate is purely *subtractive* on admission and does not touch
the atomic assignment (`:863`) or introduce any counting. Feature #4 (concurrency caps) layers
**after** #7 inside the same per-candidate loop: #7 removes maintenance-covered candidates from
consideration, then #4 applies its cap to whatever survives. Concretely, #4 slots its check in
right after #7's `continue` and before `eligible.push(c.id)` (`:821`). Neither feature reorders
the other's checks; #7 lands first and #4's diff is additive on top. The single
`getAppSetting(MAINTENANCE_KEY)` read is #7's only new query on the hot path (and only in the
non-global path — global short-circuits before it matters).

### 3.3 Heartbeat propagation (S2)

`heartbeat(...)` (`runner-service.ts:385`) gains `drain: boolean` in its return object. It is a
**pure read** of the maintenance state — no atomic-consume (unlike `update`/`restart`, drain is a
*level*, not a one-shot edge; it must keep being reported every beat until an operator clears it):

```
const maint = (await getAppSetting<MaintenanceState>(db, MAINTENANCE_KEY)) ?? EMPTY;
// An agent drains when the whole fleet is draining, OR when everything IT could claim is paused.
// For the cutover, `global` is the driver. Per-system/per-client pauses do NOT set drain=true
// (the runner should keep working un-paused systems); they're enforced purely by the claim gate.
const drain = maint.global === true;
```

Return becomes
`{ ok, enabled, update, restart, discover, migrate, drain }`. Older runners ignore an unknown
field (PowerShell reads only the properties it names), so this is backward-compatible — an
un-upgraded runner simply won't self-idle, but the `claim()` gate still starves it of work
(`global` → `return []`). Defense in depth: even a runner that never learns about `drain` claims
nothing during a global drain.

**Ordering vs. the migrate flag.** Both a drain and an app-URL migration can be pending at once.
The runner honors `drain` *after* `update`/`restart`/`migrate` in the heartbeat-response handling
(see 3.4) — an update/restart/migrate is a stronger, one-shot instruction that re-execs or moves
the process; a drain just makes it idle. Since `update`/`restart`/`migrate` never return, a drain
only takes effect when none of them fired this beat, which is the correct precedence.

### 3.4 Runner behavior — finish current, claim nothing (S4)

The runner already executes jobs in a sequential `foreach` (`:3237`) with per-job teardown in
`finally` (`:3489`). Because a claim batch is fetched *before* the loop and the loop runs to
completion, the natural, safe behavior is: **honor `drain` at the top of the poll cycle, before
`claim()` — never mid-batch.** A job already claimed this or a prior cycle finishes normally
(including its `finally` session teardown); we simply stop *claiming more*.

Exact edit to `Start-IamRunner.ps1` (the one file #7 touches in the runner; VERSION bumped once
at integration per S5):

- After the existing flag handling at `:3232` (`migrate`) and **before** the `claim` call at
  `:3235`, add:
  ```powershell
  $script:Draining = ($hb.PSObject.Properties['drain'] -and $hb.drain -eq $true)
  if ($script:Draining) {
      Update-CtgHeartbeat -Path $global:CtgHeartbeatFile -Phase 'draining'  # keep watchdog happy while idle
      Write-Host "maintenance drain active — finishing nothing new; idling until it clears" -ForegroundColor Yellow
      $jobs = @()            # claim nothing this cycle
      Start-Sleep -Seconds $PollSeconds
      continue               # skip claim + the job foreach; loop back to heartbeat next cycle
  }
  ```
  This sits inside the existing `try` (`:3222`). `$jobs = @()` keeps the `:3522` sleep-tail
  invariant intact (the `continue` bypasses it, but setting `$jobs` empty is belt-and-suspenders
  and matches the `:3191` "reset before try" discipline). The runner keeps **heartbeating** while
  drained — so it still self-updates, still migrates, and re-checks `drain` every `PollSeconds`;
  the moment the operator clears maintenance, the next heartbeat returns `drain:false` and it
  resumes claiming with no restart.

Because the check is *before* `claim()` and a job in hand is only ever inside the `foreach` that
already ran to completion this cycle, there is **no mid-job interruption path** — "finish the
current job, claim nothing new" falls out of the existing structure for free. The `finally`
teardown (`:3489`) still runs for the in-flight job, so no session is left bound.

### 3.5 Drain-complete detection

"Drained" = the maintenance state is set (so nothing new is being admitted) **and** there is no
in-flight work left. In-flight = `Job.status ∈ {dispatched, running}` (the `OPEN` set minus
`pending`; `pending` jobs are fine to leave sitting — they simply won't be claimed while drain is
on). This is a cheap count query, surfaced two ways:

```
const inFlight = await db.job.count({ where: { status: { in: ["dispatched", "running"] } } });
```

- **For a global drain:** `drained === global && inFlight === 0`. When this holds, the UI banner
  flips from "Draining… N jobs still running" to "Fully drained — safe to cut over," and an
  `AuditLog` row `maintenance.drained` is written **once** (guard: only write if the previous
  observed count was > 0, or use a `maintenance.drainedAt` field on the state set via
  `claimAppSetting` so the transition is recorded race-safely and not re-emitted every poll).
- **For scoped drains:** the same count, filtered to the paused scope
  (`systemKey in systems` OR `case.clientId in clients`), tells the operator when that slice is
  quiet — but scoped maintenance rarely needs a hard "fully drained" signal, so this is
  informational only.

The count is read by the settings/agents page loader (server component) and refreshed on the
page's existing poll cadence (the Agents page already live-polls; reuse it). No new background
sweep — the heartbeat pulse doesn't need to compute this.

### 3.6 Resume semantics

Clearing maintenance = writing `{ global:false, systems:[], clients:[] }` (or removing a single
system/client from the arrays). On the **next heartbeat** each runner sees `drain:false` and, on
the **next `claim()`**, the gate stops excluding candidates. Resume is therefore automatic and
requires no runner restart, no re-plan, and no per-agent action. Any job that sat `pending`
through the drain is picked up in dependency order exactly as before — the drain never mutated
job rows, only withheld them, so there is nothing to un-wind. Fully idempotent: clearing an
already-clear state is a no-op write.

### 3.7 RBAC

Toggling maintenance is a fleet-wide operational lever with the same blast radius as agent
management and the app-URL migration — both of which gate on `settings.manage`. **Reuse
`settings.manage`** (held by `super_admin`, `global_admin`; NOT `ops_manager`, matching how
`changeAppUrl`/migration are gated at `agents/actions.ts:163`). No new `Permission` is needed:
`settings.manage` already means "manage app-wide flags," which is exactly what this is. This keeps
the permission matrix unchanged (no `ALL_PERMISSIONS` edit, no migration) and is defensible —
maintenance mode is a setting, not a per-case or per-client action.

The server action guards with `await requirePermission("settings.manage")` and records the actor
into `MaintenanceState.by` + an `AuditLog` row (`maintenance.enter` / `maintenance.exit` /
`maintenance.change`, actor + reason + the full new state in `detail`), following the
`changeAppUrl` → `recordAudit` pattern verbatim.

### 3.8 Error handling & idempotency

- **Race-safe writes.** The toggle uses `claimAppSetting(db, MAINTENANCE_KEY, expected, next)`
  (the read-value it just fetched as `expected`) so two admins toggling at once can't clobber each
  other silently — the loser gets `false` back and re-reads. `setAppSetting` (unconditional
  upsert) is acceptable for the simple on/off since the value is idempotent, but `claimAppSetting`
  is preferred for the array edits (add/remove a system) where lost updates matter.
- **Fail-open on read.** If `getAppSetting` returns `null` or unparseable JSON (its own `catch`
  already returns `null`, `settings.ts:8`), `claim()` and `heartbeat` treat it as "no
  maintenance." A corrupt setting must never *stop* the fleet by accident, and must never *falsely
  drain* — fail-open is the safe default for a pause switch (the operator explicitly turns it on;
  absence means off).
- **Idempotent toggling.** Entering maintenance when already in it, or clearing when already
  clear, is a no-op write with the same resulting state. Repeated heartbeats during a drain each
  independently read `drain:true` — no consume, no edge, no double-effect. The runner's
  `$script:Draining` is recomputed every beat from the live flag, so a flap (on→off→on) converges
  on the next beat with no stuck state.
- **Global short-circuit correctness.** During a global drain `claim()` returns `[]` *before* the
  stale/wedged reclaim blocks (`:583`, `:608`). This is deliberate: we do not want reclaims
  re-queuing work into a fleet we're trying to quiesce. The moment drain clears, the next claim
  runs the reclaims normally, so any lease that genuinely went stale during the drain window is
  still recovered — just deferred until resume.
- **Disabled/priority-standby agents** are unaffected: `enabled:false` still `break`s the runner
  (unchanged), and the global short-circuit returns before `shouldStandBy`, so a drained fleet
  doesn't depend on failover state.

---

## 4. Shared-seam conformance

| Seam | Requirement | This design |
|------|-------------|-------------|
| **S1(a)** | Own the FIRST admission gate in `claim()`; run before concurrency caps (#4); design so #4 slots in after cleanly. | Global short-circuit right after the `enabled` check (~`:564`); per-candidate `maintenanceBlocks(...) continue` at the top of the loop body (`:775`), before deps/secrets/host-affinity. #4 layers after #7's `continue`, before `eligible.push` (`:821`). Purely subtractive; no change to the atomic assignment. |
| **S2** | Add `{drain: bool}` to the heartbeat response; runner finishes current job then idles until it clears. | `heartbeat()` return gains `drain` (pure read of `maintenance.state.global`). Runner honors it before `claim()`; a job already in the `foreach` finishes with its `finally` teardown. |
| **S3** | AppSetting keys under `maintenance.*`. | Single key `maintenance.state`. |
| **S4** | Touch `runner/Start-IamRunner.ps1` (honor drain); list the exact edit; VERSION bumped once at integration. | One insert between `:3232` and `:3235` (the `$script:Draining` / idle / `continue` block in 3.4). No VERSION bump in this feature's diff — done once at integration. |
| **S5** | Small UI toggle to enter/exit maintenance; reuse the design system. | Section 5 UI; server action mirrors `changeAppUrl`; flat/minimal per CLAUDE.md host design system. |

**Shared files touched (all also touched by sibling finalization features — coordinate at
integration):**

- `web/lib/jobs/runner-service.ts` — `claim()` gate (shared with **#4 only**, per S1; #7 lands
  first) + `heartbeat()` return field. New `MAINTENANCE_KEY` const.
- `web/lib/jobs/runner-logic.ts` — new pure `maintenanceBlocks` + `MaintenanceScope` type.
- `runner/Start-IamRunner.ps1` — the drain-honoring insert (VERSION bumped once at integration, S4).
- `web/app/api/agents/heartbeat/route.ts` — no code change needed (it forwards the service return
  verbatim, `:27`), but its response shape changes; note it in the integration PR.

**Not touched:** `web/prisma/schema.prisma` (no new model/field — `AppSetting` reused; the
optional `drainedAt` transition marker lives inside the JSON value, not a column),
`web/lib/auth/permissions.ts` (reuses `settings.manage`).

---

## 5. UI (S5)

A single card on the Settings page ("Maintenance & drain"), following the flat host design system
(sentence case, minimal borders, no gradients):

- **Global toggle** — "Pause all dispatch (drain the fleet)" with an optional reason field. When
  on, a persistent banner shows across the app: "Maintenance mode — dispatch is paused. N jobs
  still running" → "Fully drained — safe to cut over" once `inFlight === 0` (3.5).
- **Scoped controls** (secondary, collapsible) — multi-select of systems and of clients to pause
  without a full drain. These do not set the runner `drain` flag; they only filter `claim()`.
- **Status readout** — in-flight count (dispatched + running), last changed by/at, current reason.
  Reuses the Agents page poll cadence to refresh.
- Server actions (`enterMaintenance` / `exitMaintenance` / `updateMaintenanceScope`) in a
  `"use server"` module, each guarded by `requirePermission("settings.manage")`, writing via
  `claimAppSetting`, auditing via `recordAudit`, and `revalidatePath`-ing settings + agents.

The banner is the operator's cutover instrument: toggle global on → watch the count fall to zero →
pull the Azure switch → toggle global off on the new host once agents re-point.

---

## 6. Testing

- **Pure unit (`runner-logic.test.ts`)** — `maintenanceBlocks`: global blocks everything; a
  system in `systems` blocks only that key; a client in `clients` blocks only that client id;
  empty state blocks nothing; a candidate matching neither passes.
- **`claim()` integration (existing runner-service test harness)** —
  1. global drain → `claim()` returns `[]` and does NOT run stale/wedged reclaims (assert no
     `job.lease.reclaim` audit and no rows flipped);
  2. per-system drain → a paused-system candidate is skipped while a sibling un-paused candidate on
     the same case is still eligible;
  3. per-client drain → all of that client's candidates skipped, another client's untouched;
  4. clearing state → candidates become eligible again with no row mutation in between (a job left
     `pending` through the drain is now claimed);
  5. seam ordering → with both #7 and #4 present, a maintenance-covered candidate is dropped before
     #4's cap counts it (guard against #4 counting phantom candidates). *(Written at #4 integration.)*
- **`heartbeat` test** — return includes `drain:true` iff `maintenance.state.global`; scoped-only
  state yields `drain:false`.
- **Runner (Pester, `~/.local/pwsh/pwsh`)** — mock `Invoke-AppApi` heartbeat to return
  `drain:true`; assert `claim` is NOT called that cycle, the loop `continue`s, and the heartbeat
  file is refreshed with phase `draining` (watchdog stays armed); then `drain:false` → `claim`
  called again. (Note the Pester mocking gotchas from the runner-testing memory.)
- **Drain-complete** — count query returns 0 only when no dispatched/running rows; the
  `maintenance.drained` audit is emitted exactly once on the >0→0 transition, not every poll.
- **Manual live-verify (pre-cutover rehearsal)** — on the dev fleet: enter global drain, confirm a
  running job finishes and posts its result, confirm no new claims, confirm the banner reaches
  "fully drained," clear it, confirm resume with no restart.

---

## 7. Sequencing & dependencies

- **Lands FIRST among the `claim()`-editing features** (S1 mandate): only #7 and #4 may edit
  `claim()`; #7 goes in before #4. #7's gate must be present and its placement stable before #4's
  cap is written, so #4 can slot in at the documented point (`:821`, after #7's `continue`).
- **Independent of** the other finalization features except through the shared files listed in §4;
  no data-model migration, so no ordering constraint against migration-bearing siblings.
- **VERSION bump** deferred to integration (S4) — do not bump `runner/VERSION` in this feature's
  own diff; the integrator bumps once for all runner-touching finalization features together
  (avoids the collision noted for runner 1.93.0 in prior PRs #217–#220).
- **Blocking for the Azure cutover itself:** this feature is the prerequisite for a clean cutover,
  so it should be the first of the set merged + deployed + live-rehearsed.

---

## 8. Open questions for Evan

1. **Scope breadth now vs later.** Recommend shipping global + per-system + per-client (one JSON
   key) but wiring `drain:true` off `global` ONLY. Do you also want a per-agent drain (drain one
   noisy runner while the rest work)? It's a clean future add (`agents:[]` in the state, OR into
   the heartbeat's `drain` decision) — worth stubbing the shape now, or leave it out entirely?
2. **Should a global drain also freeze the sweeps?** The heartbeat pulse fires the SN-intake,
   conn-test, procurement, and db-backup sweeps (`:467–476`). During the Azure cutover do you want
   those paused too (they write to the DB), or is pausing *dispatch* enough? Leaning: leave sweeps
   running (they're idempotent and DB-only, no torn-case risk) — confirm.
3. **Per-system/per-client pause and `drain`.** Current design does NOT set the runner's `drain`
   flag for scoped pauses (runners keep working un-paused systems; scoped pause is enforced purely
   in `claim()`). Agreed? The alternative — telling a runner to fully idle because *some* of its
   work is paused — wastes runner capacity, so I recommend against it.
4. **RBAC.** Reusing `settings.manage` (super/global admin) — no `ops_manager`. For a cutover
   that's fine, but if ops managers run routine maintenance windows, do you want a dedicated
   `maintenance.toggle` permission granted to `ops_manager` too? (One-line matrix add — cheap, but
   I default to NOT widening per CLAUDE.md.)
5. **Auto-clear on the new host.** After cutover the new Azure host starts with whatever
   `maintenance.state` the DB carries over. If we cut over *while* global drain is on, the new host
   comes up drained (safe, but someone must remember to clear it). Want an env-guarded startup
   auto-clear, or is the banner + a runbook step enough?

---

## Summary

**Approach:** one AppSetting key `maintenance.state` (global + per-system + per-client, one JSON
object) drives a subtractive admission gate that is the FIRST decision in `claim()` — a global
short-circuit right after the `enabled` check plus a `maintenanceBlocks(...)` `continue` in the
per-candidate loop, leaving a clean insertion point for Feature #4's caps immediately after. The
heartbeat return gains `drain` (a pure read of `global`); the runner honors it *before* `claim()`,
so a job already in the `foreach` finishes with its normal `finally` teardown and nothing new is
claimed — "finish current, claim nothing" falls out of the existing loop structure for free.
Drain-complete = zero `dispatched`+`running` jobs, surfaced as a cutover banner. Resume is a
single write; runners pick it up on the next beat with no restart. RBAC reuses `settings.manage`;
everything is fail-open and idempotent.

**Riskiest open question:** #2 — whether a global drain should also freeze the heartbeat-driven
sweeps (SN-intake / conn-test / procurement / db-backup). They write to the DB during the exact
window we're trying to quiesce for the Azure cutover; leaving them running is my recommendation
(idempotent, no torn-case risk) but it's the call most likely to bite during the live switch.

**Shared files touched:** `web/lib/jobs/runner-service.ts` (`claim()` gate — shared with #4 only,
#7 first; + `heartbeat` return field), `web/lib/jobs/runner-logic.ts` (new pure `maintenanceBlocks`),
`runner/Start-IamRunner.ps1` (drain-honor insert; VERSION bumped once at integration),
`web/app/api/agents/heartbeat/route.ts` (response shape only, no code change). No schema
migration; no permissions-matrix change.
