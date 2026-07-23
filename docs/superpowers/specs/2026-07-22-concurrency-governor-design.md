# Concurrency governor — design spec

- Date: 2026-07-22
- Feature: #4 (finalization batch)
- Status: draft for review
- Owner seam: S1 admission gates (b) global cap, (c) per-tenant cap, (d) per-(clientId, systemKey) ≤ 1; S3 config keys under `concurrency.*`
- Depends on: #7 (maintenance/drain gate) lands first in `claim()`. Consumer: #1 (runner pool) depends on rule (d).

> Note on the seam doc: `docs/superpowers/specs/2026-07-22-finalization-seams-and-sequencing.md` is referenced by the task as the coordination artifact but is **not yet committed** in this checkout. This spec is written to the seam contract as described (S1/S3, ordering vs #7) and should be reconciled against that doc when it lands.

---

## 1. Purpose & gap

The runner pool (#1) will let two or more runners of the same scope claim work concurrently
(equal-priority peers already load-balance today — see `shouldStandBy`). Nothing today bounds
how many jobs run at once, per tenant, or — critically — per `(clientId, systemKey)`.

The `Coretelligent.*` modules keep **per-system connection/session state** (an EXO session, a
Graph token bound to one tenant, a signed-in browser context). Two jobs run concurrently against
the same client's same system collide on that shared state and/or trip vendor API throttling. This
is exactly the class of bug behind incident **UM0029840**. The existing claim path has no guard
against it: two agents can each atomically claim a *different* pending job for the same
`(clientId, systemKey)` and both run.

We need a server-side **admission control at claim time** enforcing:

- **(b) Global cap** — total in-flight jobs across the fleet ≤ `globalMax`.
- **(c) Per-tenant cap** — in-flight jobs for one `clientId` ≤ `perClientMax`.
- **(d) Per-(clientId, systemKey) cap ≤ 1** — the hard safety invariant that prevents the session
  collision. This one must be **airtight under concurrent `claim()` calls**, not merely
  best-effort. (b) and (c) are throughput/politeness caps where a rare off-by-one overshoot is
  tolerable; (d) is a correctness invariant.

"In-flight" = a job in `dispatched` OR `running` (`JobStatus`). A job leaves in-flight when it
reaches a terminal state (`succeeded`/`failed`/`skipped`/`manual`) or is reclaimed back to
`pending` by the stale-lease / wedged-job reclaimers.

---

## 2. Current state (file:line)

All references are `web/lib/jobs/`.

- `runner-service.ts:561` `claim(agentId, batchSize, version)` — the only claim path. Current
  ordered gate sequence:
  1. agent lookup + enabled check (`:562`).
  2. **priority standby** — `shouldStandBy` (`:576`), returns `[]` early.
  3. stale-lease reclaim of `dispatched` jobs (`:583-595`).
  4. wedged `running` reclaim (`:603-635`).
  5. stale-code guard (`:642-647`).
  6. **candidate fetch** — `db.job.findMany` where `status:"pending", mode:"api"`, host/capability
     `notIn` exclusion, live-case / singleRun filter (`:675-693`). Returns early if empty (`:694`).
  7. per-case job load for the dependency DAG (`:697-721`).
  8. `caseMeta` load — clientId, secretOverrides, parent, `runCloudOnOwnAgent` (`:728-740`).
  9. secrets load for the preflight (`:743-750`).
  10. setup-state gate prep (opt-in, `:753-771`).
  11. **eligibility loop** (`:775-823`) — per candidate: dependency gate (`isClaimable`), all-secrets-
      not-needed demotion, host affinity, own-agent affinity, missing-secret preflight, setup-state
      gate. Accumulates `eligible: string[]` up to `batchSize`.
  12. not-needed demotion writes + case cascade (`:827-856`).
  13. **atomic assignment** (`:863-866`): `db.job.updateMany({ where:{ id:{in:eligible}, status:"pending" }, data:{ status:"dispatched", assignedAgentId, startedAt, progress:DbNull } })`.
  14. read-back of claimed rows (`:867-871`), claim audit, case `queued→running` bump (`:874-878`),
      payload enrichment (`:880+`).

- `runner-logic.ts` — pure, no-I/O decisions, unit-tested in `runner-logic.test.ts`:
  - `isClaimable` (`:47`), `blockingJobs`/`dependencyGateOpen` (`:59-70`) — dependency DAG gate.
  - `shouldStandBy` (`:76`) — priority failover.
  - `setupGateBlocks` (`:111`) — opt-in setup gate. This is the model to imitate: policy lives as a
    pure function, `claim()` supplies live counts.

- `settings.ts` — `getAppSetting<T>` (`:5`), `setAppSetting` (`:11`), `claimAppSetting` (`:21`,
  race-safe conditional write via a `WHERE value = <expected>` guard, used by the sweeps).

- Prisma `Job` model (`web/prisma/schema.prisma`): `status JobStatus`, `caseRequestId` (no
  `clientId` column on `Job` — clientId lives on `CaseRequest`). Existing hot-path indexes:
  `@@index([status, mode])`, `@@index([status, startedAt])`, `@@index([status, progressAt])`,
  `@@index([caseRequestId])`, `@@index([assignedAgentId])`.

- `run-report.ts:382-388` — `pendingReason` for a pending step, computed by **reusing** `blockingJobs`
  so the report can't disagree with the claim gate. Falls through to
  `"ready — waiting for a runner to claim it"` when nothing blocks. This is the surface where a
  cap-blocked reason should appear.

Key existing race-safety primitive: the assignment `updateMany WHERE status:"pending"` (`:863`) is
atomic **per row** — a racing agent's `updateMany` simply matches nothing for rows already flipped.
It does **not** coordinate across a group of rows: two agents can each flip a *different* pending
row of the same `(clientId, systemKey)`.

---

## 3. Design

### 3.1 In-flight counting

Counts are read **live** from the `Job` table — no persisted counter to drift (idempotent by
construction). Because `Job` has no `clientId` column, group through the case in one raw aggregate:

```sql
SELECT c."clientId" AS "clientId", j."systemKey" AS "systemKey", COUNT(*)::int AS n
FROM "Job" j
JOIN "CaseRequest" c ON c.id = j."caseRequestId"
WHERE j.status IN ('dispatched','running')
GROUP BY c."clientId", j."systemKey";
```

One indexed scan (the existing `@@index([status, mode])` leads on `status`, so the `status IN (...)`
predicate is index-usable; add a dedicated `@@index([status])` only if `EXPLAIN` shows the composite
isn't chosen). From this single result set derive all three views:

- **global** = `Σ n`
- **per-tenant** = `Σ n` grouped by `clientId`
- **per-(clientId, systemKey)** = the cell itself (`n` for the group, presence ⇒ cap (d) already at 1).

Reclaimers run **earlier** in `claim()` (`:583`, `:603`), so genuinely-dead in-flight jobs have
already been reset to `pending` before we count — the count reflects *live* work only.

We already have `caseMetaById` (clientId per candidate case, `:729`), so the app-side filter maps
each eligible job → its `clientId` with no extra query. The raw aggregate is the *only* new read.

### 3.2 Admission pipeline placement

The caps are a new **final admission stage**, orthogonal to and downstream of every existing gate.
A job blocked by dependencies, secrets, host affinity, or the setup gate never reaches the cap
stage. A cap-blocked job stays `pending` (never `failed`) and is retried on the next poll.

Ordered pipeline (composing #7 and #4 in one sequence, per S1):

```
priority standby (existing, early return)
  → reclaimers + stale-code guard (existing)
  → candidate fetch (existing)
  → dependency DAG gate      ┐
  → all-secrets-not-needed   │ existing eligibility loop → produces `eligible[]`
  → host / own-agent affinity│ (unchanged; still bounded by batchSize)
  → missing-secret preflight │
  → setup-state gate         ┘
  → (a) #7 maintenance / drain gate     ← #7 owns; read-only filter of `eligible[]`
  → (b)(c)(d) CONCURRENCY CAPS          ← #4 owns; inside the admission critical section
  → atomic assignment updateMany        ← moves INSIDE the critical section (#4 owns the move)
```

The existing eligibility loop keeps producing the `eligible: string[]` candidate id list. #7's
drain gate filters that list (read-only). Then #4's cap stage runs inside a short critical section
that also contains the assignment write.

### 3.3 The concurrency-safe enforcement mechanism (the hard part)

**The race.** Today's sequence is *count-then-assign*, and those two steps are not atomic together:

1. Agent A `claim()`: counts in-flight for `(acme, m365)` → 0.
2. Agent B `claim()`: counts in-flight for `(acme, m365)` → 0 (A hasn't written yet).
3. A `updateMany` flips job J1 (`acme`/`m365`) → dispatched. Succeeds (J1 was pending).
4. B `updateMany` flips job J2 (a *different* `acme`/`m365` job, e.g. a second case) → dispatched.
   J2 was pending, so B's per-row `WHERE status:"pending"` guard passes. Now **2 in-flight for
   (acme, m365)** — invariant (d) violated, session collision, UM0029840.

A naive fix of adding `WHERE NOT EXISTS (sibling in-flight)` to the assignment `updateMany` is
**not airtight under READ COMMITTED** (the default). Two concurrent UPDATEs on *different* candidate
rows of the same group each evaluate the `NOT EXISTS` subquery against their own snapshot; neither
locks the rows the other is about to write. This is textbook **write skew** — both see "no sibling
in-flight" and both commit. Only `SERIALIZABLE` isolation or explicit locking prevents it.

**Chosen mechanism: a global admission critical section guarded by a Postgres advisory
transaction lock, with all caps counted *inside* the lock.**

```ts
const ADMISSION_LOCK_KEY = 0x1a3c_0004n; // stable bigint; "0004" = feature #4. Never reuse.

const claimedIds = await db.$transaction(async (tx) => {
  // Serialize the admission critical section fleet-wide. Auto-released at tx end (commit OR
  // rollback) — no leak even on error. pg_advisory_xact_lock blocks until acquired.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`;

  // (1) FRESH in-flight counts, read under the lock (raw aggregate from §3.1).
  const inflight = await countsInflight(tx);

  // (2) Filter `eligible` (post-#7) against caps, using a pure helper, accounting for THIS
  //     claim's own selections as it fills the batch.
  const admit = admitUnderCaps({
    eligible,               // ids surviving all prior gates + #7's drain gate
    clientIdOf,             // id -> clientId (from caseMetaById)
    systemKeyOf,            // id -> systemKey (from candidates)
    inflight,               // { global, byClient, byClientSystem }
    caps,                   // resolved config (§3.4)
  });                       // returns the subset of ids we're allowed to flip now

  if (admit.ids.length === 0) return [];

  // (3) Atomic assignment — the SAME write as today, now inside the lock. The status:"pending"
  //     guard still stands (a job could have been demoted/skipped by a non-claim mutation).
  await tx.job.updateMany({
    where: { id: { in: admit.ids }, status: "pending" },
    data: { status: "dispatched", assignedAgentId: agent.id, startedAt: new Date(), progress: Prisma.DbNull },
  });
  return admit.ids;
});
```

Why this is airtight for **(d)** *and* correct for **(b)/(c)**: only one agent is ever between
"count in-flight" and "write assignment" at a time. The second agent to enter the section counts
*after* the first has committed its assignment, so it sees the first's jobs as in-flight and backs
off any group already at its cap. No write-skew window exists because the count and the write are
serialized, not merely per-row atomic.

`admitUnderCaps` is a **pure function** (in a new `concurrency.ts`, unit-tested — mirroring
`setupGateBlocks`). It walks `eligible` in order and, for each id, checks against *running budgets*
seeded from `inflight` and decremented as it admits, so the cap holds **within a single batch** too
(a batch can't itself put two jobs into the same group, or exceed the global/tenant budget):

```ts
function admitUnderCaps(a): { ids: string[]; skipped: {id,reason}[] } {
  const ids = [];
  let usedGlobal = a.inflight.global;
  const usedClient = new Map(a.inflight.byClient);            // clientId -> n
  const usedGroup  = new Set(a.inflight.byClientSystem keys); // "clientId|systemKey" already in-flight
  for (const id of a.eligible) {
    const cid = a.clientIdOf(id), sk = a.systemKeyOf(id), gk = `${cid}|${sk}`;
    if (usedGlobal >= a.caps.globalMax)            { skip(id,"fleet at capacity"); continue; }
    if ((usedClient.get(cid)??0) >= perClientCap(a.caps, sk, cid)) { skip(id,"tenant at capacity"); continue; }
    if (usedGroup.has(gk))                         { skip(id,"another job for this client's <sk> is in flight"); continue; }
    ids.push(id); usedGlobal++; usedClient.set(cid,(usedClient.get(cid)??0)+1); usedGroup.add(gk);
  }
  return { ids, skipped };
}
```

**Why a single global lock, not per-group locks or SERIALIZABLE:**

- The critical section is *tiny* — one aggregate read + one `updateMany` (single-digit ms). Agents
  poll every ~5s; even a 20-agent pool contends for this section for a few ms per 5s. Global
  serialization of the admission write is effectively free and removes **all** race reasoning at
  once — it makes (b), (c), **and** (d) airtight with the same primitive. Per-group advisory locks
  would fix (d) but not the global/tenant counters (those are cross-group), forcing a second
  mechanism.
- All read-only gating (dependency, secrets, host affinity, setup, #7 drain) stays **outside** the
  lock — only the count + admit + assign are serialized. The expensive candidate/case/secret loads
  are not held under the lock.
- `SERIALIZABLE` would also work but turns the race into *retryable serialization failures* the
  caller must loop on; an advisory lock just blocks briefly and is simpler to reason about and to
  test. `pg_advisory_xact_lock` auto-releases on commit **and** rollback, so an exception inside
  the transaction can't leak the lock.

**Optional defense-in-depth for (d) only (recommended, separately sequenced):** denormalize an
immutable `clientId` onto `Job` (safe — a case never changes client; write it at job-create/plan
time) and add a **partial unique index**:

```sql
CREATE UNIQUE INDEX job_one_inflight_per_client_system
  ON "Job" ("clientId", "systemKey")
  WHERE status IN ('dispatched','running') AND "singleRun" = false;
```

This is a DB-level *guarantee* of (d) that survives any future code path that forgets the lock. It
is a backstop, **not** the primary mechanism, because: (i) it can't express the counting caps
(b)/(c); (ii) a batch `updateMany` that would violate it **throws** and aborts the whole statement
rather than skipping one group — so if we rely on it we must claim (d)-governed rows one-per-group
and catch `P2002`. With the advisory lock as the primary mechanism the index should essentially
never fire; treat a fired violation as an alarm (log + audit) that the lock was bypassed. The
`singleRun = false` predicate carves out operator "run this step only" (see open questions).
Ship this in a **later** increment than the lock, since it needs a schema migration + `clientId`
backfill.

### 3.4 Config (S3)

One AppSetting object under key `concurrency` (JSON-as-text, read via `getAppSetting`):

```jsonc
{
  "enabled": true,                 // master switch; false ⇒ governor is a no-op (unlimited)
  "globalMax": 20,                 // rule (b)
  "perClientMax": 3,               // rule (c) default
  "perClientSystemMax": 1,         // rule (d) — 1; exposed but changing it is discouraged
  "perSystemOverrides": {          // optional per-system ceilings (tighter vendor throttles)
    "spanning": { "globalMax": 4 },
    "mimecast": { "perClientMax": 1 }
  }
}
```

- Read once per `claim()` **only when `eligible.length > 0`** — an idle agent (the common case)
  pays nothing. Fold into the existing settings reads.
- **Defaults when unset / `enabled:false`:** governor disabled ⇒ behavior identical to today
  (no caps). This makes the feature safe to land dark and turn on deliberately, and safe to disable
  in an incident. Defaults above are proposals for Evan (open question).
- `perClientCap(caps, systemKey, clientId)` and the global check consult `perSystemOverrides` first,
  then the flat defaults. Overrides are min() against the base cap (an override can only *tighten*).
- Writes use `setAppSetting` from a Settings admin page (consistent with `setup_gate`,
  `agent-auto-update`, etc.). No `claimAppSetting` needed — the governor never self-mutates config.

### 3.5 Interaction with dependency ordering + priority standby

- **Orthogonal & downstream.** Dependency gate, secret preflight, host affinity, and setup gate all
  run *before* the cap stage and produce `eligible`. Caps only ever *remove* ids from `eligible`;
  they never add or reorder. A job the dependency gate blocked is invisible to the cap stage.
- **Priority standby is unaffected** — `shouldStandBy` returns early (`:576`), long before the cap
  stage. A standing-by backup claims nothing regardless of caps.
- **Load-balancing among equal peers still works, and is now cap-correct.** Equal-priority peers
  both reach the cap stage; the global lock makes them take turns in the tiny critical section — the
  first fills groups up to the caps, the next sees the updated counts and backs off full groups.
  This is precisely the desired behavior under a cap (no double-claim, no starvation).
- **Ordering fairness.** `eligible` preserves the candidate `orderBy: [caseRequestId, sequence]`
  (`:691`). `admitUnderCaps` walks it in that order, so under contention the lowest
  `(caseRequestId, sequence)` wins a scarce slot — deterministic, no reordering surprises.
- **batchSize interaction.** The existing loop already caps `eligible` at `batchSize`. The cap stage
  may admit fewer than `eligible.length`; that's fine — the unadmitted stay pending for the next
  poll. (A future refinement: keep filling toward `batchSize` from candidates the cap stage skipped
  for a *now-satisfied* different group — not needed for v1.)

### 3.6 Error handling & idempotency

- **Idempotent.** Caps are computed from live table state each poll; there is no counter to
  reconcile after a crash. A job that fails to be admitted this poll is simply retried next poll
  (every ~5s). Re-running `claim()` with identical inputs yields the same admission decision modulo
  live in-flight changes.
- **Fail-open on config read error.** If the `concurrency` setting is missing or unparseable,
  `getAppSetting` returns `null` ⇒ treat as `enabled:false` (governor off). We must never wedge the
  whole fleet because a settings row is malformed. (Contrast the *hard* rule (d): if the setting is
  present and enabled, (d) is enforced; "fail-open" applies only to the *absence/corruption* of
  config, matching how `setup_gate` defaults off.)
- **Transaction scope kept minimal.** Only count + admit + assign are inside `$transaction`. The
  post-assignment read-back (`:867`), audit, case status bump, and payload enrichment stay **outside**
  the transaction (they already tolerate being non-atomic with the flip and shouldn't extend the
  locked section). The transaction returns the admitted id list; the existing read-back keys off it.
- **Lock auto-release.** `pg_advisory_xact_lock` releases on commit or rollback; a thrown error
  inside the tx can't strand the lock. No manual unlock, no `try/finally`.
- **No partial-batch corruption.** If the `updateMany` inside the tx throws, the whole tx rolls
  back — no job is left half-assigned and the counts we read are discarded. Next poll retries.
- **Cap breach is never destructive.** A capped job stays `pending`. Nothing is failed, skipped, or
  demoted by the governor (unlike the not-needed demotion path, which the governor does not touch).

### 3.7 Surfacing "cap-blocked" in the run report

`run-report.ts:382-388` computes `pendingReason` by reusing `blockingJobs`. Extend it so a step that
is dependency-*clear* but cap-blocked reads a truthful reason instead of the generic
"ready — waiting for a runner to claim it". To keep report and claim in agreement (the existing
design principle there), expose a pure `concurrencyBlockReason(job, inflight, caps)` from
`concurrency.ts` and call it from both `admitUnderCaps` (for the skip reason/audit) and the run
report. The run report needs the same fleet in-flight aggregate (§3.1) — one extra grouped query per
report render; acceptable, or defer this to a follow-up (open question: is the extra per-render
query worth it, or is "ready — waiting for a runner" good enough for v1?).

---

## 4. Shared-seam conformance

- **S1 (admission gates).** #4 owns gates (b)(c)(d). They run **after** #7's gate (a)
  maintenance/drain and **before** the atomic assignment, in the single ordered pipeline of §3.2.
  #4 owns *moving the assignment `updateMany` inside the admission critical section* (the
  transaction + advisory lock). #7's gate (a) is a read-only filter on `eligible` that runs *before*
  the lock is taken, so it doesn't extend the locked section.
- **S3 (config).** All keys live under a single `concurrency` AppSetting object (§3.4). No new
  top-level keys; no collision with `setup_gate`, `agent-auto-update`, intake, backup, or migration
  settings.
- **Shared files touched** (coordinate with #7 — we are the only two features editing `claim()`):
  - `web/lib/jobs/runner-service.ts` — `claim()` body: add the cap stage + wrap count/admit/assign
    in the advisory-locked transaction. **Assume #7 has already inserted gate (a);** layer (b)(c)(d)
    immediately after it. Keep the diff localized to the region between the eligibility loop's output
    and the assignment write.
  - `web/lib/jobs/runner-logic.ts` *or* new `web/lib/jobs/concurrency.ts` (preferred — keep the pure
    governor self-contained and independently testable, like `mailbox-convert`, `auto-retry`).
  - `web/lib/settings.ts` — only if we add a typed `ConcurrencySetting` + `CONCURRENCY_KEY` export
    (mirrors `INTAKE_SETTING_KEY`). No behavioral change to existing helpers.
  - `web/lib/cases/run-report.ts` — optional `pendingReason` enhancement (§3.7).
  - `web/prisma/schema.prisma` + migration — **only** for the optional (d) backstop (`Job.clientId`
    + partial unique index). Not required for the primary mechanism.
- **Contract for #1 (runner pool).** #1 may run N concurrent runners of a scope. #4 guarantees:
  *at most one in-flight job per `(clientId, systemKey)` at any instant, regardless of how many
  runners call `claim()` concurrently.* #1 relies on this and must **not** add its own per-system
  coordination. #1 must not bypass `claim()` for job acquisition — the governor lives entirely
  inside `claim()`; any alternate acquisition path would be ungoverned. The advisory lock is
  process-agnostic (it's in Postgres), so it holds across separate runner hosts and app instances.

---

## 5. Testing

**Pure unit tests** (`concurrency.test.ts`, node:test style like `runner-logic.test.ts`):

- `admitUnderCaps`: empty eligible ⇒ empty; global cap fills exactly `globalMax` then skips;
  per-tenant cap independent across clients; per-group ≤ 1 within a single batch (two eligible jobs
  for the same `(client, system)` ⇒ only the first admitted, second skip-reason set); running-budget
  decrement across a batch (mixed clients/systems); `perSystemOverrides` tighten but never loosen;
  `enabled:false` ⇒ admit all; malformed/absent config ⇒ admit all (fail-open); order preserved
  (lowest `caseRequestId,sequence` wins a scarce slot).
- `concurrencyBlockReason`: correct human string per cap kind.

**Concurrency / race tests** (integration, real Postgres — the crux):

- *Two concurrent claims, same group.* Seed two pending jobs J1, J2 both `(acme, m365)`, two enabled
  agents. Fire `claim(agentA)` and `claim(agentB)` concurrently (`Promise.all`). Assert exactly one
  of {J1, J2} ends `dispatched` and the other stays `pending`. Repeat under a loop (e.g. 50×) to
  shake out timing. This is the UM0029840 regression test.
- *Global cap under concurrency.* Seed `globalMax+K` pending jobs across distinct groups, fire many
  concurrent claims; assert in-flight count never exceeds `globalMax` at commit.
- *Per-tenant cap under concurrency.* Distinct systems, one client, `perClientMax+K` jobs; assert
  never exceeds `perClientMax`.
- *Lock auto-release on error.* Force the inner `updateMany` to throw (e.g. invalid data via a
  spy/fault injection); assert the advisory lock is not held afterward (a subsequent `claim`
  proceeds) and no job was left `dispatched`.
- *Reclaim → re-admit.* A job reclaimed from a dead lease back to `pending` frees its group; assert a
  sibling then becomes admissible.
- *Governor off.* `enabled:false` ⇒ behavior byte-identical to pre-feature (a snapshot/parity test
  vs the current claim, or assert no cap skips recorded).

**Optional-backstop tests** (only if the partial unique index ships): attempt to force two in-flight
rows for one group via a direct write path that skips the lock; assert `P2002` and that the row
stays uncommitted.

Note the repo's Postgres MCP + existing integration harness; the race tests need a real DB
(SQLite/mocks can't reproduce advisory-lock semantics or READ COMMITTED write skew).

---

## 6. Sequencing & dependencies

1. **#7 lands first** — its gate (a) is in `claim()` before we touch it. Rebase #4 on #7.
2. #4 increment 1 (primary, no migration): `concurrency.ts` pure helpers + tests →
   `ConcurrencySetting` in `settings.ts` → wire the advisory-locked cap stage into `claim()` →
   race tests. Ship with `enabled:false` default (dark).
3. #4 increment 2 (surfacing): run-report `pendingReason` + Settings admin UI for the caps.
4. #4 increment 3 (optional backstop): `Job.clientId` denormalization migration + backfill +
   partial unique index + `P2002` handling. Sequence last; independent of increments 1–2.
5. **#1 (runner pool) depends on increment 1** being merged and `enabled:true` before N-runner
   concurrency is turned on in production.

---

## 7. Open questions for Evan

1. **Default cap values.** Proposed `globalMax:20`, `perClientMax:3`, `perClientSystemMax:1`. Right
   ballpark for the current fleet + vendor throttles? Any system that needs a tighter global ceiling
   out of the gate (Spanning? Mimecast? browser jobs, which are central-only and Playwright-heavy)?
2. **Ship enabled or dark?** Recommend landing `enabled:false` and flipping on deliberately once #1
   is ready. Agree?
3. **Do `singleRun` ("run this step only") and ad-hoc jobs (password reset, force-sync) count toward
   caps / rule (d)?** They ride the `Job` table. A single-ran `m365` step while a normal `m365` job
   is in-flight is *still* a session collision — arguably (d) should cover them. But `singleRun` is
   designed to run in isolation even while the case is paused, and blocking it on an unrelated case's
   in-flight job may surprise operators. Proposal: **(d) covers them** (safety wins), but the
   optional unique-index predicate carves `singleRun` out to avoid a hard DB block; ad-hoc keys
   (`ADHOC_SYSTEM_KEYS`) are governed by the app-level cap but excluded from the index. Confirm.
4. **Per-tenant cap dimension.** Is `perClientMax` counted on the case's own `clientId`, or should a
   **child** account count against its **parent** tenant (parent/child inheritance already matters
   for secrets)? Shared Graph/EXO tenants suggest counting against the parent for (c) and possibly
   sharing (d) at the tenant that actually owns the session. Needs a ruling.
5. **Run-report cap reason (§3.7)** — worth the extra per-render fleet aggregate query in v1, or
   leave the generic "waiting for a runner" until someone asks?
6. **Optional partial unique index** — do we want the DB-level backstop at all, given the advisory
   lock is the guarantee? It costs a migration + `clientId` backfill and a `P2002` code path.

---

## 8. Ordered implementation task breakdown

1. Create `web/lib/jobs/concurrency.ts`: types (`ConcurrencyCaps`, `Inflight`), pure
   `admitUnderCaps`, `perClientCap`, `concurrencyBlockReason`. No I/O.
2. `web/lib/jobs/concurrency.test.ts`: the pure-unit suite from §5.
3. `web/lib/settings.ts`: add `CONCURRENCY_KEY = "concurrency"` + `ConcurrencySetting` type +
   defaults resolver (fail-open on null/parse error).
4. In `runner-service.ts` `claim()`, after the eligibility loop and **after #7's drain gate**, add
   `countsInflight(tx)` (raw aggregate, §3.1) and wrap `[count → admitUnderCaps → assignment
   updateMany]` in `db.$transaction` with `pg_advisory_xact_lock(ADMISSION_LOCK_KEY)`. Move the
   existing assignment `updateMany` inside; keep read-back/audit/case-bump/enrichment outside.
   Guard the whole stage behind `caps.enabled` and `eligible.length > 0`.
5. Record cap skips in the claim audit `detail` (e.g. `{ capped: [{id, reason}] }`) so operators can
   see the governor acting. Reuse the existing `job.claim` audit line or add a `job.claim.capped`.
6. Integration race tests (§5) against real Postgres.
7. (increment 2) `run-report.ts` `pendingReason` enhancement + `concurrencyBlockReason` reuse (§3.7).
8. (increment 2) Settings admin UI to edit the `concurrency` object (mirror the `setup_gate` toggle
   surface).
9. (increment 3, optional) Prisma migration: `Job.clientId` (denormalized, immutable) + backfill +
   partial unique index; add `P2002` catch in the assignment path as a logged alarm.
10. Changelog entry per commit (per project convention) + memory note on ship.

---

## Summary

Approach: add a final **admission stage** to `claim()` — orthogonal to and downstream of the
existing dependency/secret/host/setup gates and #7's drain gate — that enforces a global in-flight
cap (b), a per-tenant cap (c), and the hard per-`(clientId, systemKey)` ≤ 1 invariant (d) that
prevents the shared-session collision behind incident UM0029840. In-flight is counted **live** from
`Job` (status in dispatched/running) via one raw aggregate joined through `CaseRequest` for clientId;
policy is a pure, unit-tested `admitUnderCaps` with running per-batch budgets. Race-safety mechanism:
a **single fleet-wide `pg_advisory_xact_lock` around a tight critical section** containing count →
admit → the existing atomic assignment `updateMany`. I chose it over a bare `WHERE NOT EXISTS`
(which suffers write skew under READ COMMITTED and cannot make (d) airtight), over per-group locks
(they fix (d) but not the counting caps (b)/(c)), and over SERIALIZABLE (retry loops) because the
critical section is single-digit-ms, it makes all three caps airtight with one primitive, and the
lock auto-releases on commit/rollback. A partial unique index (needs a `Job.clientId` denormalization)
is offered as an optional defense-in-depth backstop for (d) only, sequenced last. Config lives under
one `concurrency` AppSetting (S3), fail-open on absence, shippable dark. Riskiest open question:
whether the per-tenant cap and rule (d) should key on the **parent** tenant for child accounts (shared
Graph/EXO sessions suggest yes) — it changes the counting dimension. Shared files: `runner-service.ts`
(claim, coordinated with #7 who lands first), new `concurrency.ts`, `settings.ts`, optionally
`run-report.ts` and a `schema.prisma` migration for the backstop.
