# M365 auto-setup Phase 4/5 — end-to-end + fleet run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the merged M365 auto-setup core (`setupM365ForClient`) into a usable feature — a per-client "Set up M365 automatically" button and a fleet-wide sweep — by building the real `dispatchDeviceCodeJob`, a progress-tracked detached run engine, its API routes, and the UI.

**Architecture:** A new `M365SetupRun` + `M365SetupRunClient` table tracks a run's progress (mirrors `FleetAudit`). A detached run engine (mirrors `web/lib/audits/audit-runs.ts` `startRun`) iterates target clients, calls the already-tested pure `setupM365ForClient(input, deps)` per client with real dependencies, and writes each client's stage/result to `M365SetupRunClient`. Two routes (per-client + fleet) start a run and expose a GET status the UI polls. `dispatchDeviceCodeJob` creates a minimal synthetic `CaseRequest` + an `entra-devicecode` browser `Job` (the browser leg runs on a Playwright-capable runner — already gated).

**Tech Stack:** Next.js App Router + Prisma/PostgreSQL (`web/`); `node:test` via `tsx --test`; the existing Delinea/Graph/device-code libs from PR #126.

## Global Constraints

- **Reuse, don't reinvent:** `ENTRA_DEVICECODE_KEY = "entra-devicecode"` already exists (`web/lib/jobs/adhoc.ts:14`) and is in `BROWSER_SYSTEMS` (`web/lib/runner/capabilities.ts:67`) and `ADHOC_SYSTEM_KEYS` — reuse it; do NOT add browser-capability gating (already wired). `insertStepSequence` is in `web/lib/jobs/adhoc.ts`.
- **The pure core is fixed:** `setupM365ForClient(input: SetupInput, deps: SetupDeps): Promise<SetupResult>` (`web/lib/secrets/setup-m365-client.ts:129`) — do NOT change it; wire real `deps` around it. `SetupInput = { client: {id,slug,name,primaryDomain?,delineaFolderId?}, tenant: string, caps? }`. `SetupResult = { ok, stage: "no-ga-secret"|"device-code-init"|"browser-signin"|"token"|"provision"|"write"|"done"|"error", appId?, wroteCreds?, verified?, gaps?, userCode?, verificationUri?, error?, browserWarnings?, actions[] }`.
- **The house async model:** a run takes minutes/client and CANNOT run inside a request — start it, return, poll a status GET. Mirror `startRun`'s detached (`void fn()`), `STALE_AFTER_MS = 30*60*1000`, `isStale`, and finish-off-stale pattern from `web/lib/audits/audit-runs.ts`.
- **Permission gates:** per-client run → `guard("client.edit_secrets")` + `scopeAllows(currentClientScope, clientId)`. Fleet run (mutating, stronger) → `guard("client.edit_secrets")` AND `fleetWideAccess(db, user.id)` (requires all-clients access, like the client-add routes). Both audited via `recordAudit(...)`.
- **Dry-run = eligibility preview only:** provisioning genuinely mutates (creates app registrations), so a fleet dry-run does NOT device-code/provision — it reports which clients are eligible (have an `m365-global-admin` secret) and what would run. A real per-client setup is never "dry".
- **Live-validation boundary:** the browser device-code leg + the full chain cannot be exercised here (no Playwright/tenant). Unit-test the wiring/engine/gating with mocked deps + a fake db; the operator validates one live client before fleet rollout. Do NOT write tests that require a real tenant.
- **House rules:** idempotent; an `AuditLog` row per start; a changelog entry per commit (`web/lib/changelog/entries/*.ts`, registered id-sorted, `date`/`time` = `TZ=America/New_York date '+%Y-%m-%d %H:%M'` floored to 15 min, not future); commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. tsc gate: only the 3 known pre-existing `warningsDismissed` errors.

## File structure

- **Create** `web/prisma/schema.prisma` models `M365SetupRun` + `M365SetupRunClient` (Task 1) + migration `web/prisma/migrations/20260720120000_m365_setup_run/migration.sql`.
- **Create** `web/lib/secrets/dispatch-device-code-job.ts` — `dispatchDeviceCodeJob` (Task 2).
- **Create** `web/lib/secrets/setup-m365-deps.ts` — `buildSetupDeps(db)` real `SetupDeps` factory (Task 3).
- **Create** `web/lib/secrets/m365-setup-run.ts` — the detached run engine (`startM365SetupRun`, `latestM365SetupRun`) (Task 4).
- **Create** `web/app/api/clients/[slug]/m365-setup/route.ts` — per-client POST/GET (Task 5).
- **Create** `web/app/api/m365-setup/route.ts` — fleet POST/GET (Task 6).
- **Create** `web/app/clients/_components/m365-setup-button.tsx` — per-client button + poller panel (Task 7).
- **Modify** `web/app/clients/[slug]/page.tsx` — render the button in the toolbar (Task 7).
- **Create** `web/app/fleet-audit/_components/m365-setup-fleet.tsx` + wire into the fleet-audit page (Task 8).
- **Create** a changelog entry (Task 9, folded into the final task).

---

## Task 1: `M365SetupRun` + `M365SetupRunClient` schema + migration

**Files:**
- Modify: `web/prisma/schema.prisma` (add two models)
- Create: `web/prisma/migrations/20260720120000_m365_setup_run/migration.sql`

**Interfaces — Produces:** two Prisma models the run engine reads/writes.

- [ ] **Step 1: Add the models to the schema.** Append after the `FleetAudit` model (`web/prisma/schema.prisma:866`):

```prisma
// A run of the automated M365 app-registration setup — one client ("client" scope) or the fleet
// ("fleet" scope). Mirrors FleetAudit's start/track/read shape; per-client detail lives in
// M365SetupRunClient. Takes minutes per client, so the work runs detached and the UI polls this row.
model M365SetupRun {
  id         String               @id @default(cuid())
  scope      String // "client" | "fleet"
  status     String               @default("running") // running | done | failed
  dryRun     Boolean              @default(false) // fleet eligibility preview — no device-code/provision
  startedAt  DateTime             @default(now())
  finishedAt DateTime?
  startedBy  String? // actor label snapshot ("user:jane@core.tech")
  total      Int                  @default(0) // clients this run intends to visit
  completed  Int                  @default(0) // clients reaching any terminal per-client state
  succeeded  Int                  @default(0)
  skipped    Int                  @default(0)
  failed     Int                  @default(0)
  error      String?
  clients    M365SetupRunClient[]

  @@index([scope, startedAt]) // "the latest run of this scope"
}

// One client's outcome within a run. Its stage/warnings mirror SetupResult so the UI can show exactly
// where it stopped and why (incl. a non-automatable-MFA browser warning).
model M365SetupRunClient {
  id              String       @id @default(cuid())
  run             M365SetupRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  runId           String
  clientId        String
  slug            String
  name            String
  status          String       @default("pending") // pending | running | done | skipped | failed
  stage           String? // SetupResult.stage
  appId           String?
  wroteCreds      Boolean?
  verified        Boolean?
  skipReason      String? // e.g. "no m365-global-admin secret"
  error           String?
  warnings        String[] // SetupResult.browserWarnings (e.g. "WARN MFA push not automatable")
  userCode        String? // device user-code, surfaced while running for a manual fallback
  verificationUri String?
  updatedAt       DateTime     @updatedAt

  @@index([runId])
}
```

- [ ] **Step 2: Write the migration** `web/prisma/migrations/20260720120000_m365_setup_run/migration.sql` (additive, idempotent — mirrors the `20260716220000_connector` style):

```sql
-- Automated M365 app-registration setup runs: a run (client | fleet) + its per-client outcomes.
-- Additive + idempotent: two new tables, nothing else touched.
CREATE TABLE IF NOT EXISTS "M365SetupRun" (
    "id"         TEXT NOT NULL,
    "scope"      TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'running',
    "dryRun"     BOOLEAN NOT NULL DEFAULT false,
    "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedBy"  TEXT,
    "total"      INTEGER NOT NULL DEFAULT 0,
    "completed"  INTEGER NOT NULL DEFAULT 0,
    "succeeded"  INTEGER NOT NULL DEFAULT 0,
    "skipped"    INTEGER NOT NULL DEFAULT 0,
    "failed"     INTEGER NOT NULL DEFAULT 0,
    "error"      TEXT,
    CONSTRAINT "M365SetupRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "M365SetupRunClient" (
    "id"              TEXT NOT NULL,
    "runId"           TEXT NOT NULL,
    "clientId"        TEXT NOT NULL,
    "slug"            TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "stage"           TEXT,
    "appId"           TEXT,
    "wroteCreds"      BOOLEAN,
    "verified"        BOOLEAN,
    "skipReason"      TEXT,
    "error"           TEXT,
    "warnings"        TEXT[],
    "userCode"        TEXT,
    "verificationUri" TEXT,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "M365SetupRunClient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "M365SetupRun_scope_startedAt_idx" ON "M365SetupRun"("scope", "startedAt");
CREATE INDEX IF NOT EXISTS "M365SetupRunClient_runId_idx" ON "M365SetupRunClient"("runId");

ALTER TABLE "M365SetupRunClient"
  ADD CONSTRAINT "M365SetupRunClient_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "M365SetupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate the Prisma client + verify parse.** Run: `cd web && npx prisma generate`. Expected: succeeds, `M365SetupRun`/`M365SetupRunClient` available on the client. (Do NOT run `prisma migrate dev` against the shared dev DB — apply to an isolated DB only; see [[db-reset-incident-2026-07-13]].) Then `cd web && npx tsc --noEmit` — only the 3 known errors.

- [ ] **Step 4: Commit.** `git add web/prisma/schema.prisma web/prisma/migrations/20260720120000_m365_setup_run && git commit` with message `feat(m365-setup): M365SetupRun + M365SetupRunClient progress tables` + trailer.

---

## Task 2: `dispatchDeviceCodeJob` — synthetic case + entra-devicecode job

**Files:**
- Create: `web/lib/secrets/dispatch-device-code-job.ts`
- Test: `web/lib/secrets/dispatch-device-code-job.test.ts`

**Interfaces:**
- Consumes: `ENTRA_DEVICECODE_KEY` (`web/lib/jobs/adhoc.ts:14`), a `SetupClientInput`-shaped `{ id }`.
- Produces: `dispatchDeviceCodeJob(db, client, userCode) => Promise<{ jobId: string }>` — creates a synthetic `CaseRequest` (`action:"onboard"`, `createdSource:"api"`) + an `entra-devicecode` `Job` carrying `config.userCode` + the `m365-global-admin` secret name, and returns the job id. This becomes the real impl the `SetupDeps.dispatchDeviceCodeJob` factory (Task 3) wraps.

- [ ] **Step 1: Write the failing test** (`dispatch-device-code-job.test.ts`, `node:test`, a fake db recording creates):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchDeviceCodeJob } from "./dispatch-device-code-job";

function fakeDb() {
  const created: { case?: any; job?: any } = {};
  return {
    created,
    caseRequest: { create: async ({ data }: any) => { created.case = data; return { id: "case-1" }; } },
    job: { create: async ({ data }: any) => { created.job = data; return { id: "job-1" }; } },
  } as any;
}

test("creates a synthetic onboard case then an entra-devicecode job carrying the userCode + GA secret", async () => {
  const db = fakeDb();
  const r = await dispatchDeviceCodeJob(db, { id: "client-1", slug: "acme", name: "Acme" } as any, "ABCD-EFGH");
  assert.equal(r.jobId, "job-1");
  // synthetic case: onboard, api source, tied to the client
  assert.equal(db.created.case.action, "onboard");
  assert.equal(db.created.case.createdSource, "api");
  assert.equal(db.created.case.clientId, "client-1");
  // job: entra-devicecode, api mode, singleRun, carries userCode + the GA secret
  assert.equal(db.created.job.caseRequestId, "case-1");
  assert.equal(db.created.job.systemKey, "entra-devicecode");
  assert.equal(db.created.job.mode, "api");
  assert.equal(db.created.job.singleRun, true);
  assert.equal(db.created.job.request.config.userCode, "ABCD-EFGH");
  assert.deepEqual(db.created.job.request.secretNames, ["m365-global-admin"]);
});
```

- [ ] **Step 2: Run — FAIL.** `cd web && npx tsx --test lib/secrets/dispatch-device-code-job.test.ts` → "Cannot find module".

- [ ] **Step 3: Implement** `web/lib/secrets/dispatch-device-code-job.ts`:

```ts
import type { PrismaClient, Prisma } from "@prisma/client";
import { ENTRA_DEVICECODE_KEY } from "@/lib/jobs/adhoc";

// The GA login the runner's device-code browser flow signs in WITH (interactive UPN+password, OTP on
// the secret). Must match field-requirements.ts "m365-global-admin".
const GA_SECRET_NAME = "m365-global-admin";

type ClientRef = { id: string };

// Create a MINIMAL synthetic case to host ONE entra-devicecode browser job. A Job needs a non-null
// caseRequestId FK and there is no lightweight "system case" factory, so we mint an onboard/api case
// with an empty-ish payload flagged m365AutoSetup. The job is singleRun (claimable in isolation, no
// cascade). Browser-capability claim gating is already wired (BROWSER_SYSTEMS includes this key).
export async function dispatchDeviceCodeJob(
  db: PrismaClient,
  client: ClientRef,
  userCode: string
): Promise<{ jobId: string }> {
  const caseRequest = await db.caseRequest.create({
    data: {
      clientId: client.id,
      action: "onboard",
      createdSource: "api",
      subject: "M365 automated setup (device-code sign-in)",
      payload: { m365AutoSetup: true } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const request = {
    secretNames: [GA_SECRET_NAME],
    config: { userCode },
    dependsOn: [],
    requiresApproval: false,
    captureEvidence: false,
  } as Prisma.InputJsonValue;
  const job = await db.job.create({
    data: {
      caseRequestId: caseRequest.id,
      systemKey: ENTRA_DEVICECODE_KEY,
      mode: "api",
      sequence: 1,
      status: "pending",
      singleRun: true,
      request,
    },
    select: { id: true },
  });
  return { jobId: job.id };
}
```

- [ ] **Step 4: Run — PASS.** `cd web && npx tsx --test lib/secrets/dispatch-device-code-job.test.ts`. tsc clean.

- [ ] **Step 5: Commit.** `feat(m365-setup): dispatchDeviceCodeJob — synthetic case + entra-devicecode job` + trailer.

---

## Task 3: `buildSetupDeps(db)` — real `SetupDeps` factory

**Files:**
- Create: `web/lib/secrets/setup-m365-deps.ts`
- Test: `web/lib/secrets/setup-m365-deps.test.ts`

**Interfaces:**
- Consumes: `startDeviceCode`, `pollDeviceCodeToken` (`web/lib/secrets/device-code-auth.ts`), `provisionM365App` (`provision-m365-app.ts`), `writeProvisionedM365App` (`write-m365-app.ts`), `dispatchDeviceCodeJob` (Task 2), the `SetupDeps` type (`setup-m365-client.ts:45`).
- Produces: `buildSetupDeps(db: PrismaClient): SetupDeps` — the real dependency bundle `setupM365ForClient` runs against.

- [ ] **Step 1: Write the failing test** — verify the factory returns all required dep keys and that `hasGlobalAdminSecret`/`getJob` hit the db as expected:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetupDeps } from "./setup-m365-deps";

test("buildSetupDeps exposes every SetupDeps key", () => {
  const deps = buildSetupDeps({} as any);
  for (const k of ["startDeviceCode", "pollDeviceCodeToken", "provisionM365App", "writeProvisionedM365App", "hasGlobalAdminSecret", "dispatchDeviceCodeJob", "getJob"]) {
    assert.equal(typeof (deps as any)[k], "function", `missing ${k}`);
  }
});

test("hasGlobalAdminSecret is true only when a m365-global-admin secret row exists", async () => {
  const db = { secret: { findUnique: async ({ where }: any) => where.clientId_name.name === "m365-global-admin" ? { id: "s" } : null } } as any;
  const deps = buildSetupDeps(db);
  assert.equal(await deps.hasGlobalAdminSecret("c1"), true);
});

test("getJob returns the job's status/result/error", async () => {
  const db = { job: { findUnique: async () => ({ status: "succeeded", result: { actions: ["ok"] }, error: null }) } } as any;
  const deps = buildSetupDeps(db);
  assert.deepEqual(await deps.getJob("j1"), { status: "succeeded", result: { actions: ["ok"] }, error: null });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `web/lib/secrets/setup-m365-deps.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type { SetupDeps } from "./setup-m365-client";
import { startDeviceCode, pollDeviceCodeToken } from "./device-code-auth";
import { provisionM365App } from "./provision-m365-app";
import { writeProvisionedM365App } from "./write-m365-app";
import { dispatchDeviceCodeJob } from "./dispatch-device-code-job";

const GA_SECRET_NAME = "m365-global-admin";

// The real dependency bundle setupM365ForClient runs against in production. Pure wiring — the pieces
// are already unit-tested; keep this thin so it needs no tests beyond "every key is present + the two
// db-touching deps query correctly".
export function buildSetupDeps(db: PrismaClient): SetupDeps {
  return {
    startDeviceCode: (tenant) => startDeviceCode(tenant),
    pollDeviceCodeToken: (tenant, deviceCode, opts) => pollDeviceCodeToken(tenant, deviceCode, opts),
    provisionM365App: (input) => provisionM365App(input),
    writeProvisionedM365App: (input) => writeProvisionedM365App(input, { db }),
    hasGlobalAdminSecret: async (clientId) => {
      const row = await db.secret.findUnique({ where: { clientId_name: { clientId, name: GA_SECRET_NAME } }, select: { id: true } });
      return row != null;
    },
    dispatchDeviceCodeJob: (client, userCode) => dispatchDeviceCodeJob(db, client, userCode),
    getJob: async (jobId) => {
      const j = await db.job.findUnique({ where: { id: jobId }, select: { status: true, result: true, error: true } });
      return { status: j?.status ?? "unknown", result: j?.result ?? null, error: j?.error ?? null };
    },
  };
}
```

- [ ] **Step 4: Run — PASS.** tsc clean. **Commit** `feat(m365-setup): real SetupDeps factory (buildSetupDeps)` + trailer.

---

## Task 4: the detached run engine `m365-setup-run.ts`

**Files:**
- Create: `web/lib/secrets/m365-setup-run.ts`
- Test: `web/lib/secrets/m365-setup-run.test.ts`

**Interfaces:**
- Consumes: `SetupClientInput`/`SetupResult` (`setup-m365-client.ts`), the Prisma models (Task 1).
- Produces:
  - `type SetupTarget = { id: string; slug: string; name: string; primaryDomain: string | null; delineaFolderId: string | null }`
  - `type RunSetupFn = (client: SetupClientInput, tenant: string) => Promise<SetupResult>`
  - `startM365SetupRun(db, args, deps) => Promise<{ started: boolean; id?: string; reason?: string }>` where `args = { scope: "client" | "fleet"; targets: SetupTarget[]; dryRun?: boolean; startedBy: string | null }` and `deps = { runSetup: RunSetupFn; hasGlobalAdminSecret: (clientId: string) => Promise<boolean>; now?: () => Date; detach?: (fn: () => Promise<void>) => void; deadlineMs?: number }`.
  - `latestM365SetupRun(db, scope) => Promise<M365SetupRun & { clients: M365SetupRunClient[] } | null>`
  - `M365_SETUP_STALE_AFTER_MS` + `isSetupStale(startedAt, now)`.

- [ ] **Step 1: Write the failing tests** (`m365-setup-run.test.ts`) — cover: a client with no GA secret is SKIPPED (never runSetup'd), a success increments `succeeded`, a browser-signin failure records the warnings + `failed`, dry-run does NOT call runSetup, and the deadline stops starting new clients. Use a synchronous `detach` (`fn => runs.push(fn())`) and a fake db that records `M365SetupRunClient` upserts.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { startM365SetupRun } from "./m365-setup-run";

function fakeDb() {
  const state: any = { run: null, clients: [] as any[] };
  return {
    state,
    m365SetupRun: {
      findFirst: async () => null,
      create: async ({ data }: any) => { state.run = { id: "run-1", ...data }; return state.run; },
      update: async ({ data }: any) => { Object.assign(state.run, data); return state.run; },
    },
    m365SetupRunClient: {
      create: async ({ data }: any) => { const row = { id: `rc-${state.clients.length}`, ...data }; state.clients.push(row); return row; },
      update: async ({ where, data }: any) => { const row = state.clients.find((c: any) => c.id === where.id); Object.assign(row, data); return row; },
    },
  } as any;
}
const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, slug: `c${i}`, name: `C${i}`, primaryDomain: `c${i}.com`, delineaFolderId: null }));
const drain = async () => { await new Promise((r) => setImmediate(r)); };

test("a client without a GA secret is skipped and never run", async () => {
  const db = fakeDb();
  const runSetup = async () => { throw new Error("must not run"); };
  const r = await startM365SetupRun(db, { scope: "client", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => false, detach: (fn) => { void fn(); },
  });
  assert.equal(r.started, true);
  await drain();
  assert.equal(db.state.clients[0].status, "skipped");
  assert.match(db.state.clients[0].skipReason, /m365-global-admin/);
  assert.equal(db.state.run.skipped, 1);
  assert.equal(db.state.run.status, "done");
});

test("a successful client increments succeeded and records appId", async () => {
  const db = fakeDb();
  const runSetup = async () => ({ ok: true, stage: "done", appId: "app-x", wroteCreds: true, verified: true, actions: [] } as any);
  await startM365SetupRun(db, { scope: "client", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); },
  });
  await drain();
  assert.equal(db.state.clients[0].status, "done");
  assert.equal(db.state.clients[0].appId, "app-x");
  assert.equal(db.state.run.succeeded, 1);
});

test("a browser-signin failure is recorded as failed with the warnings", async () => {
  const db = fakeDb();
  const runSetup = async () => ({ ok: false, stage: "browser-signin", error: "device code not recognized", browserWarnings: ["WARN MFA push not automatable"], actions: [] } as any);
  await startM365SetupRun(db, { scope: "fleet", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); },
  });
  await drain();
  assert.equal(db.state.clients[0].status, "failed");
  assert.deepEqual(db.state.clients[0].warnings, ["WARN MFA push not automatable"]);
  assert.equal(db.state.run.failed, 1);
});

test("dry-run marks eligible clients skipped-preview without calling runSetup", async () => {
  const db = fakeDb();
  const runSetup = async () => { throw new Error("must not run in dry-run"); };
  await startM365SetupRun(db, { scope: "fleet", targets: targets(2), dryRun: true, startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); },
  });
  await drain();
  assert.equal(db.state.clients.length, 2);
  assert.equal(db.state.clients[0].status, "skipped");
  assert.match(db.state.clients[0].skipReason, /dry run|would run|preview/i);
});

test("the deadline stops starting new clients", async () => {
  const db = fakeDb();
  let t = 0; const now = () => new Date(t);
  const runSetup = async () => { t += 1000; return { ok: true, stage: "done", actions: [] } as any; };
  await startM365SetupRun(db, { scope: "fleet", targets: targets(5), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); }, now, deadlineMs: 1500,
  });
  await drain();
  const ran = db.state.clients.filter((c: any) => c.status === "done").length;
  const deadlined = db.state.clients.filter((c: any) => c.status === "skipped" && /deadline/i.test(c.skipReason ?? "")).length;
  assert.ok(ran <= 2, `ran ${ran}`);
  assert.ok(deadlined >= 1, "some clients marked deadline-skipped");
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `web/lib/secrets/m365-setup-run.ts` (mirror `audit-runs.ts` structure):

```ts
import type { PrismaClient } from "@prisma/client";
import type { SetupClientInput, SetupResult } from "./setup-m365-client";

export const M365_SETUP_STALE_AFTER_MS = 30 * 60 * 1000;
// Default wall-clock ceiling for a fleet sweep: each client can burn ~15 min on device-code expiry, so
// an unbounded fleet run could take a whole day. Stop STARTING new clients past this; in-flight ones finish.
export const DEFAULT_RUN_DEADLINE_MS = 2 * 60 * 60 * 1000;

export function isSetupStale(startedAt: Date, now: Date): boolean {
  return now.getTime() - startedAt.getTime() > M365_SETUP_STALE_AFTER_MS;
}

export type SetupTarget = { id: string; slug: string; name: string; primaryDomain: string | null; delineaFolderId: string | null };
export type RunSetupFn = (client: SetupClientInput, tenant: string) => Promise<SetupResult>;

export type StartArgs = { scope: "client" | "fleet"; targets: SetupTarget[]; dryRun?: boolean; startedBy: string | null };
export type RunDeps = {
  runSetup: RunSetupFn;
  hasGlobalAdminSecret: (clientId: string) => Promise<boolean>;
  now?: () => Date;
  detach?: (fn: () => Promise<void>) => void;
  deadlineMs?: number;
};
export type StartResult = { started: boolean; id?: string; reason?: string };

export async function latestM365SetupRun(db: PrismaClient, scope: "client" | "fleet") {
  return db.m365SetupRun.findFirst({ where: { scope }, orderBy: { startedAt: "desc" }, include: { clients: true } });
}

// Tenant for the device-code flow: the client's primary domain is a valid tenant hint; fall back to
// "organizations" so the flow still initiates (the GA sign-in resolves the real tenant).
function tenantFor(t: SetupTarget): string {
  return t.primaryDomain && t.primaryDomain.includes(".") ? t.primaryDomain : "organizations";
}

export async function startM365SetupRun(db: PrismaClient, args: StartArgs, deps: RunDeps): Promise<StartResult> {
  const now = deps.now ?? (() => new Date());
  const detach = deps.detach ?? ((fn: () => Promise<void>) => { void fn(); });
  const deadlineMs = deps.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS;

  // One live run per scope; a duplicate mutating sweep is NOT harmless, so this is a real guard (stale
  // runs are finished off so a crash can't wedge the button forever).
  const live = await db.m365SetupRun.findFirst({ where: { scope: args.scope, status: "running" }, orderBy: { startedAt: "desc" } });
  if (live && !isSetupStale(live.startedAt, now())) return { started: false, reason: "a setup run is already in progress", id: live.id };
  if (live) await db.m365SetupRun.update({ where: { id: live.id }, data: { status: "failed", finishedAt: now(), error: "the app restarted while this run was in progress" } });

  const run = await db.m365SetupRun.create({ data: { scope: args.scope, dryRun: Boolean(args.dryRun), startedBy: args.startedBy, total: args.targets.length } });

  detach(async () => {
    const deadline = now().getTime() + deadlineMs;
    let completed = 0, succeeded = 0, skipped = 0, failed = 0;
    try {
      for (const t of args.targets) {
        const row = await db.m365SetupRunClient.create({
          data: { runId: run.id, clientId: t.id, slug: t.slug, name: t.name, status: "pending" },
        });
        // Deadline: stop starting new clients (in-flight none, since sequential).
        if (now().getTime() > deadline) {
          await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "skipped", skipReason: "run deadline reached before this client was reached" } });
          skipped++; completed++; continue;
        }
        // Dry-run: eligibility preview only — never device-code/provision.
        if (args.dryRun) {
          const eligible = await deps.hasGlobalAdminSecret(t.id);
          await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "skipped", skipReason: eligible ? "dry run — would run (has GA secret)" : "dry run — would skip (no m365-global-admin secret)" } });
          skipped++; completed++; continue;
        }
        // Real: pre-skip when there's no GA login for the runner to sign in with.
        if (!(await deps.hasGlobalAdminSecret(t.id))) {
          await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "skipped", skipReason: "no m365-global-admin secret" } });
          skipped++; completed++; continue;
        }
        await db.m365SetupRunClient.update({ where: { id: row.id }, data: { status: "running" } });
        let res: SetupResult;
        try {
          res = await deps.runSetup({ id: t.id, slug: t.slug, name: t.name, primaryDomain: t.primaryDomain, delineaFolderId: t.delineaFolderId }, tenantFor(t));
        } catch (e) {
          res = { ok: false, stage: "error", error: (e as Error).message, actions: [] };
        }
        // Surface the device user-code + warnings so the UI can show a manual fallback / MFA reason.
        await db.m365SetupRunClient.update({
          where: { id: row.id },
          data: {
            status: res.ok ? "done" : "failed",
            stage: res.stage,
            appId: res.appId ?? null,
            wroteCreds: res.wroteCreds ?? null,
            verified: res.verified ?? null,
            error: res.ok ? null : (res.error ?? null),
            warnings: res.browserWarnings ?? [],
            userCode: res.userCode ?? null,
            verificationUri: res.verificationUri ?? null,
          },
        });
        if (res.ok) succeeded++; else failed++;
        completed++;
        await db.m365SetupRun.update({ where: { id: run.id }, data: { completed, succeeded, skipped, failed } }).catch(() => {});
      }
      await db.m365SetupRun.update({ where: { id: run.id }, data: { status: "done", finishedAt: new Date(), completed, succeeded, skipped, failed } });
    } catch (e) {
      await db.m365SetupRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), error: (e as Error).message, completed, succeeded, skipped, failed } }).catch(() => {});
    }
  });

  return { started: true, id: run.id };
}
```

- [ ] **Step 4: Run — PASS.** Full suite (`cd web && npx tsx --test "lib/**/*.test.ts"`) green; tsc clean.
- [ ] **Step 5: Commit** `feat(m365-setup): detached run engine (per-client + fleet, skip/dry-run/deadline)` + trailer.

---

## Task 5: per-client route `POST/GET /api/clients/[slug]/m365-setup`

**Files:**
- Create: `web/app/api/clients/[slug]/m365-setup/route.ts`
- Test: none (route wiring; the engine + gating are tested in Task 4 and covered by tsc). Verify by tsc + reading.

**Interfaces:**
- Consumes: `guard`, `currentClientScope`/`scopeAllows` (`client-scope.ts`), `startM365SetupRun`/`latestM365SetupRun` (Task 4), `buildSetupDeps` (Task 3), `setupM365ForClient` (`setup-m365-client.ts`), `recordAudit`/`auditActor`.

- [ ] **Step 1: Implement** `web/app/api/clients/[slug]/m365-setup/route.ts` (mirror the fleet-audit route's POST/GET shape + the force-spanning-sync guard/scope pattern):

```ts
// POST /api/clients/:slug/m365-setup — start the automated M365 app-registration setup for ONE client.
// GET  /api/clients/:slug/m365-setup — the latest client-scoped run's state, for the UI poll.
// Mutating (creates an Entra app registration + writes a Delinea secret): gated on client.edit_secrets
// and the caller's client scope, and audited.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { buildSetupDeps } from "@/lib/secrets/setup-m365-deps";
import { setupM365ForClient } from "@/lib/secrets/setup-m365-client";
import { startM365SetupRun, latestM365SetupRun } from "@/lib/secrets/m365-setup-run";

export const dynamic = "force-dynamic";

async function loadClient(slug: string) {
  return db.client.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, primaryDomain: true, delineaFolderId: true } });
}

export async function POST(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const client = await loadClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scope = await currentClientScope(db);
  if (!scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const deps = buildSetupDeps(db);
  const r = await startM365SetupRun(db, {
    scope: "client",
    targets: [{ id: client.id, slug: client.slug, name: client.name, primaryDomain: client.primaryDomain, delineaFolderId: client.delineaFolderId }],
    startedBy: auditActor(_g.user, "ui").label,
  }, {
    runSetup: (c, tenant) => setupM365ForClient({ client: c, tenant }, deps),
    hasGlobalAdminSecret: deps.hasGlobalAdminSecret,
  });
  if (!r.started) return NextResponse.json({ started: false, reason: r.reason, id: r.id }, { status: 409 });
  await recordAudit("m365.setup.start", { user: _g.user, clientId: client.id, detail: { scope: "client", runId: r.id } });
  return NextResponse.json({ started: true, id: r.id });
}

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const client = await loadClient(params.slug);
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scope = await currentClientScope(db);
  if (!scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const run = await latestM365SetupRun(db, "client");
  // Only surface a run whose single client is THIS one (the client-scope run table is shared).
  const mine = run?.clients.find((c) => c.clientId === client.id);
  if (!run || !mine) return NextResponse.json({ run: null });
  return NextResponse.json({
    run: { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt },
    client: { status: mine.status, stage: mine.stage, appId: mine.appId, verified: mine.verified, wroteCreds: mine.wroteCreds, error: mine.error, warnings: mine.warnings, userCode: mine.userCode, verificationUri: mine.verificationUri, skipReason: mine.skipReason },
  });
}
```

- [ ] **Step 2: Verify.** `cd web && npx tsc --noEmit` — only the 3 known errors. **Commit** `feat(m365-setup): per-client setup route (start + status)` + trailer.

---

## Task 6: fleet route `POST/GET /api/m365-setup`

**Files:**
- Create: `web/app/api/m365-setup/route.ts`

**Interfaces:**
- Consumes: same as Task 5 + `fleetWideAccess` (`web/lib/auth/fleet-access.ts`), `auditTargets` (`web/lib/audits/m365-audit.ts`).

- [ ] **Step 1: Implement** `web/app/api/m365-setup/route.ts`. The fleet sweep is the strongest-gated: `client.edit_secrets` AND `fleetWideAccess`. Targets = every client that has an `m365-admin` audit target OR — better for setup — every client the caller can see; use `auditTargets(db)` is WRONG here (it lists clients that already HAVE m365-admin). For setup we want clients that CAN be set up: those with a wired `m365-global-admin` secret. Query them directly:

```ts
// POST /api/m365-setup — start the fleet-wide automated M365 setup sweep (or a dry-run eligibility
// preview). Mutating across the fleet: requires client.edit_secrets AND all-clients access.
// GET  /api/m365-setup — the latest fleet run's state + per-client roll-up, for the page poll.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { fleetWideAccess } from "@/lib/auth/fleet-access";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { buildSetupDeps } from "@/lib/secrets/setup-m365-deps";
import { setupM365ForClient } from "@/lib/secrets/setup-m365-client";
import { startM365SetupRun, latestM365SetupRun } from "@/lib/secrets/m365-setup-run";

export const dynamic = "force-dynamic";

export async function POST(req: Request, _ctx: unknown) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const access = await fleetWideAccess(db, _g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
  // Clients that CAN be set up: those with a wired m365-global-admin GA-login secret (the runner needs
  // it to sign in). Non-archived only; restricted-scoping is unnecessary here — fleetWideAccess already
  // requires all-clients access.
  const secrets = await db.secret.findMany({
    where: { name: "m365-global-admin", client: { archivedAt: null } },
    select: { client: { select: { id: true, slug: true, name: true, primaryDomain: true, delineaFolderId: true } } },
    orderBy: { client: { name: "asc" } },
  });
  const targets = secrets.map((s) => s.client);

  const deps = buildSetupDeps(db);
  const r = await startM365SetupRun(db, {
    scope: "fleet",
    targets,
    dryRun: Boolean(body.dryRun),
    startedBy: auditActor(_g.user, "ui").label,
  }, {
    runSetup: (c, tenant) => setupM365ForClient({ client: c, tenant }, deps),
    hasGlobalAdminSecret: deps.hasGlobalAdminSecret,
  });
  if (!r.started) return NextResponse.json({ started: false, reason: r.reason, id: r.id }, { status: 409 });
  await recordAudit("m365.setup.start", { user: _g.user, detail: { scope: "fleet", dryRun: Boolean(body.dryRun), targets: targets.length, runId: r.id } });
  return NextResponse.json({ started: true, id: r.id, targets: targets.length });
}

export async function GET(_req: Request, _ctx: unknown) {
  const _g = await guard("client.edit_secrets"); if (_g.res) return _g.res;
  const access = await fleetWideAccess(db, _g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });
  const run = await latestM365SetupRun(db, "fleet");
  if (!run) return NextResponse.json({ run: null });
  return NextResponse.json({
    run: { id: run.id, status: run.status, dryRun: run.dryRun, startedAt: run.startedAt, finishedAt: run.finishedAt, total: run.total, completed: run.completed, succeeded: run.succeeded, skipped: run.skipped, failed: run.failed, error: run.error },
    clients: run.clients.map((c) => ({ slug: c.slug, name: c.name, status: c.status, stage: c.stage, appId: c.appId, verified: c.verified, error: c.error, warnings: c.warnings, skipReason: c.skipReason })),
  });
}
```

- [ ] **Step 2: Verify.** tsc clean. **Commit** `feat(m365-setup): fleet setup sweep route (edit_secrets + fleet-wide gate, dry-run)` + trailer.

---

## Task 7: per-client button + status poller UI

**Files:**
- Create: `web/app/clients/_components/m365-setup-button.tsx`
- Modify: `web/app/clients/[slug]/page.tsx` (import + render in the toolbar at ~line 306)

**Interfaces:** Consumes `POST/GET /api/clients/[slug]/m365-setup` (Task 5).

- [ ] **Step 1: Implement** `web/app/clients/_components/m365-setup-button.tsx` (mirror `replan-cases-button.tsx` for the POST + `connection-test-panel.tsx` for the poll-while-running loop):

```tsx
"use client";

// "Set up M365 automatically" — provision this client's iam-engine app registration end to end
// (device-code Global-Admin sign-in in a runner browser -> Graph app-reg -> Delinea write-back).
// Starts a detached run and polls its status; shows the device user-code (for a manual fallback) and
// any browser sign-in warnings (e.g. non-automatable MFA).
import { useCallback, useEffect, useRef, useState } from "react";

type ClientState = {
  status: string; stage?: string | null; appId?: string | null; verified?: boolean | null;
  wroteCreds?: boolean | null; error?: string | null; warnings?: string[]; userCode?: string | null;
  verificationUri?: string | null; skipReason?: string | null;
};

export function M365SetupButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ClientState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/clients/${slug}/m365-setup`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setState(d.client ?? null);
    } catch (e) { setError((e as Error).message); }
  }, [slug]);

  // Poll while the client's run is unsettled.
  useEffect(() => {
    if (!state) return;
    const running = state.status === "pending" || state.status === "running";
    if (timer.current) clearTimeout(timer.current);
    if (running) timer.current = setTimeout(load, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [state, load]);

  useEffect(() => { void load(); }, [load]);

  async function start() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/m365-setup`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) { setError(d.error ?? `failed (${r.status})`); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const running = state?.status === "pending" || state?.status === "running";
  return (
    <span>
      <button disabled={busy || running} title="Automatically create + configure this client's iam-engine M365 app registration and vault the credential"
        onClick={start}>
        {running ? "Setting up…" : busy ? "Starting…" : "Set up M365 automatically"}
      </button>
      {state && (
        <span className="note" style={{ marginLeft: 8 }}>
          {state.status === "done" && (state.verified ? `Done — app ${state.appId ?? ""} configured & verified.` : `Done — app ${state.appId ?? ""} (some permissions still pending).`)}
          {state.status === "skipped" && `Skipped: ${state.skipReason ?? "not eligible"}.`}
          {state.status === "failed" && `Failed at ${state.stage}: ${state.error ?? "unknown"}${state.warnings?.length ? ` — ${state.warnings[0]}` : ""}`}
          {running && state.userCode && (
            <> In progress — if MFA needs a hand, sign in at <a href={state.verificationUri ?? "https://microsoft.com/devicelogin"} target="_blank" rel="noreferrer">devicelogin</a> with code <code>{state.userCode}</code>.</>
          )}
          {running && !state.userCode && " In progress…"}
        </span>
      )}
      {error && <span className="note" style={{ marginLeft: 8, color: "#b91c1c" }}>{error}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Render it** in `web/app/clients/[slug]/page.tsx`. Add the import beside the others (~line 17-35): `import { M365SetupButton } from "../_components/m365-setup-button";` and render it in the toolbar row (~line 306-308) next to `EditSystemsButton`: `<M365SetupButton slug={client.slug} />`.

- [ ] **Step 3: Verify.** tsc clean. **Commit** `feat(m365-setup): per-client "Set up M365 automatically" button + status poller` + trailer.

---

## Task 8: fleet trigger + progress panel

**Files:**
- Create: `web/app/fleet-audit/_components/m365-setup-fleet.tsx`
- Modify: `web/app/fleet-audit/page.tsx` (render the panel — read where the permissions/leaked-seats sections mount and add a "M365 setup" section)

**Interfaces:** Consumes `POST/GET /api/m365-setup` (Task 6).

- [ ] **Step 1: Implement** `web/app/fleet-audit/_components/m365-setup-fleet.tsx` — a Dry-run + Run pair that starts the fleet sweep and polls the roll-up (mirror the per-client poller; add the dry-run body):

```tsx
"use client";

// Fleet-wide automated M365 setup: a dry-run eligibility preview and a real sweep across every client
// with a wired m365-global-admin GA-login secret. Polls the run roll-up (n/total, succeeded/skipped/failed).
import { useCallback, useEffect, useRef, useState } from "react";

type Run = { id: string; status: string; dryRun: boolean; total: number; completed: number; succeeded: number; skipped: number; failed: number; error?: string | null };
type Row = { slug: string; name: string; status: string; stage?: string | null; appId?: string | null; error?: string | null; warnings?: string[]; skipReason?: string | null };

export function M365SetupFleet() {
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/m365-setup`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setRun(d.run ?? null); setRows(d.clients ?? []);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    if (!run) return;
    if (timer.current) clearTimeout(timer.current);
    if (run.status === "running") timer.current = setTimeout(load, 4000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [run, load]);
  useEffect(() => { void load(); }, [load]);

  async function start(dryRun: boolean) {
    if (!dryRun && !confirm("Run automated M365 setup across every eligible client? This creates app registrations and writes credentials.")) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/m365-setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) { setError(d.error ?? `failed (${r.status})`); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const running = run?.status === "running";
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Automated M365 setup</h2>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button disabled={busy || running} onClick={() => start(true)}>Dry run (preview eligible)</button>
        <button disabled={busy || running} onClick={() => start(false)}>Run setup across the fleet</button>
        {run && <span className="note">{run.dryRun ? "preview" : "run"}: {run.completed}/{run.total} · {run.succeeded} ok · {run.skipped} skipped · {run.failed} failed{running ? " · running…" : ""}</span>}
        {error && <span className="note" style={{ color: "#b91c1c" }}>{error}</span>}
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
          {rows.filter((r) => r.status === "failed" || r.status === "skipped").map((r) => (
            <div key={r.slug}>{r.name} — {r.status}{r.status === "failed" ? `: ${r.error ?? r.stage}${r.warnings?.length ? ` (${r.warnings[0]})` : ""}` : `: ${r.skipReason ?? ""}`}</div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Mount it.** In `web/app/fleet-audit/page.tsx`, import `import { M365SetupFleet } from "./_components/m365-setup-fleet";` and render `<M365SetupFleet />` after the existing audit sections. (Read the page first to place it consistently; it renders its own heading.)

- [ ] **Step 3: Verify.** tsc clean. **Commit** `feat(m365-setup): fleet setup trigger + progress panel` + trailer.

---

## Task 9: changelog + full verification

- [ ] **Step 1:** Create `web/lib/changelog/entries/m365-auto-setup-usable.ts` (mirror an existing entry; floored ET time) — id `m365-auto-setup-usable`, title "Automated M365 setup is now usable — one client or the whole fleet". Items: a per-client "Set up M365 automatically" button (device-code GA sign-in in a runner browser → app registration → Delinea write-back), a fleet sweep with a dry-run eligibility preview, per-client skip when there's no GA login secret, and clear failure reasons (incl. non-automatable MFA). Register id-sorted in `_registry.ts`.
- [ ] **Step 2:** `cd web && npx tsx --test "lib/**/*.test.ts"` — full suite green (report count). `cd web && npx tsc --noEmit` — only the 3 known errors. `cd web && npx prisma generate` clean.
- [ ] **Step 3:** Commit `docs(changelog): automated M365 setup usable end-to-end` + trailer.

## Verification (feature done when)

- Unit tests green for `dispatch-device-code-job`, `setup-m365-deps`, and `m365-setup-run` (skip/success/browser-warning/dry-run/deadline); full web suite green; tsc clean; `prisma generate` clean.
- The two routes + button + fleet panel compile and wire to the engine; the migration applies to an isolated DB.
- **Live (operator, before fleet rollout):** run the per-client button against ONE real tenant + a GA account with a TOTP seed in its `m365-global-admin` Delinea secret; confirm the app registration is created + verified and the `m365-admin` secret is vaulted; then a fleet dry-run; then a small real fleet batch. Push/SMS-MFA GA accounts surface as a per-client failure with the MFA warning (expected).

## Self-review notes (done)

- **Spec coverage:** dispatchDeviceCodeJob (Task 2) ✓, M365SetupRun/Client + migration (Task 1) ✓, startRun-style detached run (Task 4) ✓, GET status endpoints (Tasks 5/6) ✓, per-client button + userCode/WARN surfacing (Task 7) ✓, fleet sweep + per-client skip + dry-run + runtime cap + stronger mutating gate (Tasks 4/6) ✓.
- **Type consistency:** `SetupTarget`/`RunSetupFn`/`RunDeps` (Task 4) are consumed verbatim by Tasks 5/6; `SetupClientInput`/`SetupResult`/`WriteResult`/`ProvisionResult` are the merged types from PR #126 (unchanged). `ENTRA_DEVICECODE_KEY` reused, not redefined.
- **Escape gate:** the mutating fleet sweep requires `client.edit_secrets` + `fleetWideAccess` (stronger than the read-only audit's lone `client.edit_secrets`), per the spec.
