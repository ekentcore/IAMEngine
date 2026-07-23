# Per-agent runner authentication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fleet-wide shared `RUNNER_API_TOKEN` + self-asserted body `agentId` with per-agent opaque tokens (hashed at rest), resolved in-handler so an agent's `clientId` always comes from its authenticated `Agent` row — making cross-client claim/broker structurally impossible.

**Architecture:** Each agent gets a unique random token at enrollment or via a remote, heartbeat-delivered refresh. A pure crypto helper mints/hashes tokens; a `authenticateAgent(db, req, claimedAgentId?)` helper resolves the bearer to an authenticated agent (per-agent token = authoritative; shared token = legacy, allowed only until cutover and never for an already-migrated agent). Every runner-API route calls it and passes the *authenticated* id into the unchanged service methods. Joint→individual migration and rotation are one remote operator action delivered through the existing heartbeat push-down pattern (`tokenRefreshRequested` flag, mirroring `updateRequested`/`restartRequested`). A `RUNNER_REQUIRE_PER_AGENT` env flag is the hard cutover.

**Tech Stack:** Next.js App Router (TypeScript), Prisma + PostgreSQL, `node:test` + `tsx` for web tests, PowerShell 7 runner (Pester tests).

## Global Constraints

- Test runner is `npm test` → `tsx --test "lib/**/*.test.ts"`. **Only files under `web/lib/**` are in the test glob.** Security logic therefore lives in `lib/`, and tests target `lib/` functions, not route handlers.
- Tests use `node:test` (`import { test } from "node:test"`) + `import assert from "node:assert/strict"`. Follow `web/lib/auth/runner-paths.test.ts`.
- **Never run `prisma migrate dev` against the shared dev DB** (see memory: db-reset incident). Create migration SQL by hand under `web/prisma/migrations/`, then run `npx prisma generate` (which does not touch the DB). Applying to a real DB is `npm run db:migrate:deploy` at ship time only.
- Token hashing is **SHA-256** (tokens are high-entropy random, not passwords). All secret comparisons use `crypto.timingSafeEqual`.
- Token format: `agt_` + `randomBytes(32).toString("base64url")`. Prefix = first 12 chars (`agt_` + 8), used only for row lookup.
- Runner change requires bumping `runner/VERSION` (minor — backward compatible: a legacy runner keeps using the shared token until refreshed). See memory: runner-version-policy.
- Changelog: append one file per entry to `web/lib/changelog/entries/`, register in `_registry.ts`, timestamp on a 15-minute boundary in Eastern time (`TZ=America/New_York date +%H:%M`). See memory: changelog-times-eastern.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Edge safety gate: the middleware admits `agt_` tokens only when `RUNNER_PER_AGENT_EDGE_ENABLED=true` (or at cutover, `RUNNER_REQUIRE_PER_AGENT=true`). This stays OFF until the route handlers validate `agt_` tokens are live, so no partial-deploy state can admit an unvalidated `agt_` bearer. Rollout sets it right after the app deploy.
- Spec: `docs/superpowers/specs/2026-07-22-per-agent-runner-auth-design.md`.

---

### Task 1: Agent schema columns + migration

**Files:**
- Modify: `web/prisma/schema.prisma:257-313` (the `Agent` model)
- Create: `web/prisma/migrations/<timestamp>_agent_per_agent_token/migration.sql`

**Interfaces:**
- Produces: `Agent.tokenHash`, `Agent.tokenPrefix`, `Agent.tokenProvisionedAt`, `Agent.tokenConfirmedAt`, `Agent.tokenRotatedAt`, `Agent.tokenRefreshRequested`, `Agent.tokenRefreshRequestedAt`, `Agent.tokenRefreshRequestedBy`, `Agent.tokenRefreshDeliveredAt`, and `@@index([tokenPrefix])` — consumed by Tasks 3, 5, 6, 7.

- [ ] **Step 1: Add the columns to the Prisma model**

In `web/prisma/schema.prisma`, inside `model Agent`, immediately after the `deletedAt DateTime?` line (`:309`), add:

```prisma
  // Per-agent auth (replaces the fleet-wide shared RUNNER_API_TOKEN). The token itself is the
  // identity: authenticateAgent() resolves it to THIS row, so clientId can't be forged via the body.
  tokenHash               String?    // sha256(fullToken) hex — NEVER the token itself
  tokenPrefix             String?    // first 12 chars of the token (agt_ + 8) — INDEXED lookup, not secret
  tokenProvisionedAt      DateTime?  // last mint+deliver (may be unconfirmed if the runner didn't adopt)
  tokenConfirmedAt        DateTime?  // set when the agent first authenticates WITH its per-agent token
  tokenRotatedAt          DateTime?  // last rotate of an already-confirmed token
  // Operator-armed remote refresh — mirrors updateRequested/restartRequested/migrateRequested.
  tokenRefreshRequested   Boolean    @default(false)
  tokenRefreshRequestedAt DateTime?
  tokenRefreshRequestedBy String?
  tokenRefreshDeliveredAt DateTime?
```

And add to the model's index block (next to `@@index([deletedAt])` at `:312`):

```prisma
  @@index([tokenPrefix])
```

- [ ] **Step 2: Hand-write the migration SQL**

Create `web/prisma/migrations/20260722000000_agent_per_agent_token/migration.sql` (use a timestamp later than the newest existing migration folder — check with `ls web/prisma/migrations | sort | tail -1`):

```sql
-- Per-agent runner auth: additive, all nullable, no backfill.
ALTER TABLE "Agent" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "Agent" ADD COLUMN "tokenPrefix" TEXT;
ALTER TABLE "Agent" ADD COLUMN "tokenProvisionedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "tokenConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "tokenRotatedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "tokenRefreshRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ADD COLUMN "tokenRefreshRequestedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "tokenRefreshRequestedBy" TEXT;
ALTER TABLE "Agent" ADD COLUMN "tokenRefreshDeliveredAt" TIMESTAMP(3);
CREATE INDEX "Agent_tokenPrefix_idx" ON "Agent"("tokenPrefix");
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd web && npx prisma generate`
Expected: "Generated Prisma Client" with no error. (Does not touch the DB.)

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors referencing `Agent`.

- [ ] **Step 5: Commit**

```bash
git add web/prisma/schema.prisma web/prisma/migrations
git commit -m "feat(agent-auth): add per-agent token columns to Agent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Token crypto helper

**Files:**
- Create: `web/lib/runner/agent-token.ts`
- Test: `web/lib/runner/agent-token.test.ts`

**Interfaces:**
- Produces:
  - `generateAgentToken(): { token: string; prefix: string; hash: string }`
  - `tokenPrefix(token: string): string`
  - `hashToken(token: string): string`
  - `verifyToken(token: string, hash: string): boolean`
  - `isAgentToken(bearer: string): boolean`
  - Consumed by Tasks 3, 5, 7.

- [ ] **Step 1: Write the failing test**

Create `web/lib/runner/agent-token.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAgentToken, tokenPrefix, hashToken, verifyToken, isAgentToken } from "./agent-token";

test("generateAgentToken produces an agt_ token whose prefix and hash round-trip", () => {
  const { token, prefix, hash } = generateAgentToken();
  assert.ok(token.startsWith("agt_"), "token is agt_-prefixed");
  assert.equal(prefix, token.slice(0, 12));
  assert.equal(prefix, tokenPrefix(token));
  assert.equal(hash, hashToken(token));
  assert.equal(verifyToken(token, hash), true);
});

test("verifyToken rejects a wrong token", () => {
  const a = generateAgentToken();
  const b = generateAgentToken();
  assert.equal(verifyToken(b.token, a.hash), false);
});

test("tokens are unique across calls", () => {
  const seen = new Set(Array.from({ length: 100 }, () => generateAgentToken().token));
  assert.equal(seen.size, 100);
});

test("isAgentToken only matches the agt_ scheme", () => {
  assert.equal(isAgentToken("agt_abc"), true);
  assert.equal(isAgentToken("shared-token-value"), false);
  assert.equal(isAgentToken(""), false);
});

test("verifyToken is length-safe (no throw on malformed hash)", () => {
  const { token } = generateAgentToken();
  assert.equal(verifyToken(token, "deadbeef"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/runner/agent-token.test.ts`
Expected: FAIL — cannot find module `./agent-token`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/runner/agent-token.ts`:

```ts
// Per-agent runner token: an opaque high-entropy secret. The token IS the agent's identity —
// authenticateAgent() resolves it to exactly one Agent row. We store only sha256(token); the
// plaintext is returned once (on mint) and never persisted. SHA-256 (not bcrypt/scrypt) is correct
// here: the token is 256 bits of randomness, not a guessable password.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const SCHEME = "agt_";
const PREFIX_LEN = SCHEME.length + 8; // "agt_" + 8 chars = 12

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LEN);
}

export function isAgentToken(bearer: string): boolean {
  return typeof bearer === "string" && bearer.startsWith(SCHEME);
}

export function generateAgentToken(): { token: string; prefix: string; hash: string } {
  const token = SCHEME + randomBytes(32).toString("base64url");
  return { token, prefix: tokenPrefix(token), hash: hashToken(token) };
}

export function verifyToken(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx tsx --test lib/runner/agent-token.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/runner/agent-token.ts web/lib/runner/agent-token.test.ts
git commit -m "feat(agent-auth): add opaque per-agent token crypto helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `authenticateAgent` — resolve the bearer to an authenticated agent

**Files:**
- Create: `web/lib/auth/agent-auth.ts`
- Test: `web/lib/auth/agent-auth.test.ts`

**Interfaces:**
- Consumes: `tokenPrefix`, `verifyToken`, `isAgentToken` (Task 2); `HttpError` from `web/lib/jobs/types`.
- Produces:
  - `type AuthedAgent = { id: string; clientId: string | null; via: "per-agent" | "shared" }`
  - `authenticateAgent(db, req, claimedAgentId?): Promise<AuthedAgent>` — where `db` is `Pick<PrismaClient, "agent">` and `req` is `{ headers: { get(name: string): string | null } }`.
  - Consumed by Task 6 (route wiring) and Task 5 (heartbeat passes `via`).

- [ ] **Step 1: Write the failing test**

Create `web/lib/auth/agent-auth.test.ts`:

```ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { authenticateAgent } from "./agent-auth";
import { generateAgentToken } from "@/lib/runner/agent-token";
import { HttpError } from "@/lib/jobs/types";

// Minimal fake of the one Prisma call authenticateAgent makes.
function fakeDb(agents: any[]) {
  return {
    agent: {
      findFirst: async ({ where }: any) => {
        return (
          agents.find((a) => {
            if (where.deletedAt === null && a.deletedAt) return false;
            if (where.tokenPrefix !== undefined) return a.tokenPrefix === where.tokenPrefix;
            if (where.id !== undefined) return a.id === where.id;
            return false;
          }) ?? null
        );
      },
    },
  } as any;
}

const req = (bearer?: string) => ({ headers: { get: (n: string) => (n.toLowerCase() === "authorization" && bearer ? `Bearer ${bearer}` : null) } });

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

test("a valid per-agent token authenticates as ITS agent, ignoring the claimed body agentId", async () => {
  const t = generateAgentToken();
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true, tokenHash: t.hash, tokenPrefix: t.prefix }]);
  const authed = await authenticateAgent(db, req(t.token), "agentB"); // caller lies: claims to be agentB
  assert.deepEqual(authed, { id: "agentA", clientId: "clientA", via: "per-agent" });
});

test("a wrong per-agent token is rejected 401", async () => {
  const real = generateAgentToken();
  const forged = generateAgentToken();
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true, tokenHash: real.hash, tokenPrefix: real.prefix }]);
  // forged has a different prefix → no row → 401
  await assert.rejects(() => authenticateAgent(db, req(forged.token)), (e: any) => e instanceof HttpError && e.status === 401);
});

test("a disabled agent is rejected 403 even with a valid token", async () => {
  const t = generateAgentToken();
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: false, tokenHash: t.hash, tokenPrefix: t.prefix }]);
  await assert.rejects(() => authenticateAgent(db, req(t.token)), (e: any) => e instanceof HttpError && e.status === 403);
});

test("the shared token is accepted in dual-mode and identity comes from the claimed agentId", async () => {
  process.env.RUNNER_API_TOKEN = "shared-xyz";
  delete process.env.RUNNER_REQUIRE_PER_AGENT;
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true, tokenConfirmedAt: null }]);
  const authed = await authenticateAgent(db, req("shared-xyz"), "agentA");
  assert.deepEqual(authed, { id: "agentA", clientId: "clientA", via: "shared" });
});

test("a CONFIRMED agent may not fall back to the shared token", async () => {
  process.env.RUNNER_API_TOKEN = "shared-xyz";
  delete process.env.RUNNER_REQUIRE_PER_AGENT;
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true, tokenConfirmedAt: new Date() }]);
  await assert.rejects(() => authenticateAgent(db, req("shared-xyz"), "agentA"), (e: any) => e instanceof HttpError && e.status === 401);
});

test("once RUNNER_REQUIRE_PER_AGENT=true the shared token is rejected outright", async () => {
  process.env.RUNNER_API_TOKEN = "shared-xyz";
  process.env.RUNNER_REQUIRE_PER_AGENT = "true";
  const db = fakeDb([{ id: "agentA", clientId: "clientA", enabled: true }]);
  await assert.rejects(() => authenticateAgent(db, req("shared-xyz"), "agentA"), (e: any) => e instanceof HttpError && e.status === 401);
});

test("a missing bearer is rejected 401", async () => {
  const db = fakeDb([]);
  await assert.rejects(() => authenticateAgent(db, req(undefined)), (e: any) => e instanceof HttpError && e.status === 401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/auth/agent-auth.test.ts`
Expected: FAIL — cannot find module `./agent-auth`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/auth/agent-auth.ts`:

```ts
// The runner trust boundary. authenticateAgent() turns a bearer token into an AUTHENTICATED agent
// identity. The per-agent token IS the identity: the returned clientId comes from the token's own
// Agent row, so a caller can never scope claims/broker to another client by lying in the body.
//
// Two token schemes exist during the migration window:
//   - per-agent (agt_...): authoritative. Resolved by prefix, verified by hash.
//   - shared (legacy RUNNER_API_TOKEN): identity still comes from the claimed body agentId, allowed
//     ONLY until cutover (RUNNER_REQUIRE_PER_AGENT) and NEVER for an already-migrated (confirmed) agent.
import { timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { HttpError } from "@/lib/jobs/types";
import { isAgentToken, tokenPrefix, verifyToken } from "@/lib/runner/agent-token";

export type AuthedAgent = { id: string; clientId: string | null; via: "per-agent" | "shared" };

type AgentDb = Pick<PrismaClient, "agent">;
type ReqLike = { headers: { get(name: string): string | null } };

function bearer(req: ReqLike): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function authenticateAgent(db: AgentDb, req: ReqLike, claimedAgentId?: string | null): Promise<AuthedAgent> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "missing bearer token");

  // --- Per-agent token: the token is the identity. ---
  if (isAgentToken(token)) {
    const agent = await db.agent.findFirst({
      where: { tokenPrefix: tokenPrefix(token), deletedAt: null },
      select: { id: true, clientId: true, enabled: true, tokenHash: true },
    });
    if (!agent?.tokenHash || !verifyToken(token, agent.tokenHash)) throw new HttpError(401, "invalid agent token");
    if (!agent.enabled) throw new HttpError(403, "agent disabled");
    return { id: agent.id, clientId: agent.clientId, via: "per-agent" };
  }

  // --- Shared token (legacy). ---
  if (process.env.RUNNER_REQUIRE_PER_AGENT === "true") throw new HttpError(401, "per-agent token required");
  const shared = process.env.RUNNER_API_TOKEN;
  if (!shared || !safeEqual(token, shared)) throw new HttpError(401, "unauthorized");
  if (!claimedAgentId) throw new HttpError(401, "agentId required with the shared token");
  const agent = await db.agent.findFirst({
    where: { id: claimedAgentId, deletedAt: null },
    select: { id: true, clientId: true, enabled: true, tokenConfirmedAt: true },
  });
  if (!agent) throw new HttpError(404, "unknown agent");
  if (!agent.enabled) throw new HttpError(403, "agent disabled");
  if (agent.tokenConfirmedAt) throw new HttpError(401, "this agent has a per-agent token; the shared token is refused");
  return { id: agent.id, clientId: agent.clientId, via: "shared" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx tsx --test lib/auth/agent-auth.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/auth/agent-auth.ts web/lib/auth/agent-auth.test.ts
git commit -m "feat(agent-auth): authenticateAgent resolves bearer to an authoritative agent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Edge gate — let per-agent tokens through, reject shared after cutover

**Files:**
- Create: `web/lib/auth/edge-runner-auth.ts`
- Test: `web/lib/auth/edge-runner-auth.test.ts`
- Modify: `web/middleware.ts:41-59`

**Interfaces:**
- Consumes: `isAgentToken` (Task 2).
- Produces: `edgeRunnerAuthDecision(input): { action: "pass" | "reject"; status?: 401 | 503 }` where `input = { bearer: string | null; sharedToken: string | undefined; requirePerAgent: boolean; secretBearing: boolean; prod: boolean }`. Consumed by `middleware.ts`.
- Rationale: the middleware runs in the Edge runtime with **no DB**, so it can only make a coarse decision. Extracting it to `lib/` is the house pattern that lets the test suite cover the trust boundary (see the comment in `runner-paths.ts`). Per-agent tokens pass here and are validated in-handler by `authenticateAgent` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `web/lib/auth/edge-runner-auth.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeRunnerAuthDecision } from "./edge-runner-auth";

const base = { sharedToken: "shared-xyz", requirePerAgent: false, secretBearing: false, prod: true };

test("a per-agent token passes the edge (validated in-handler)", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, bearer: "agt_abc" }), { action: "pass" });
});

test("the correct shared token passes in dual-mode", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, bearer: "shared-xyz" }), { action: "pass" });
});

test("a wrong shared token is rejected 401", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, bearer: "nope" }), { action: "reject", status: 401 });
});

test("no bearer is rejected 401", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, bearer: null }), { action: "reject", status: 401 });
});

test("after cutover the shared token is rejected but per-agent still passes", () => {
  const cut = { ...base, requirePerAgent: true };
  assert.deepEqual(edgeRunnerAuthDecision({ ...cut, bearer: "shared-xyz" }), { action: "reject", status: 401 });
  assert.deepEqual(edgeRunnerAuthDecision({ ...cut, bearer: "agt_abc" }), { action: "pass" });
});

test("no shared token configured: a per-agent token still passes (post-cutover steady state)", () => {
  assert.deepEqual(edgeRunnerAuthDecision({ ...base, sharedToken: undefined, bearer: "agt_abc" }), { action: "pass" });
});

test("no shared token configured + non-agent bearer on a secret-bearing route fails closed 503", () => {
  assert.deepEqual(
    edgeRunnerAuthDecision({ ...base, sharedToken: undefined, secretBearing: true, bearer: "whatever" }),
    { action: "reject", status: 503 },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/auth/edge-runner-auth.test.ts`
Expected: FAIL — cannot find module `./edge-runner-auth`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/auth/edge-runner-auth.ts`:

```ts
// Coarse edge decision for runner-API paths. The Edge runtime has NO DB, so per-agent tokens can only
// be VALIDATED in-handler (authenticateAgent). Here we just decide whether to let the request reach the
// handler. Per-agent tokens always pass through; the shared token keeps its fast edge check until the
// RUNNER_REQUIRE_PER_AGENT cutover, after which only per-agent tokens are admitted.
import { isAgentToken } from "@/lib/runner/agent-token";

export function edgeRunnerAuthDecision(input: {
  bearer: string | null;
  sharedToken: string | undefined;
  requirePerAgent: boolean;
  secretBearing: boolean;
  prod: boolean;
}): { action: "pass"; } | { action: "reject"; status: 401 | 503 } {
  const { bearer, sharedToken, requirePerAgent, secretBearing, prod } = input;

  // Per-agent tokens are validated in the handler — admit them regardless of shared-token config.
  if (bearer && isAgentToken(bearer)) return { action: "pass" };

  // From here down the caller is presenting either the shared token or garbage.
  if (requirePerAgent) return { action: "reject", status: 401 }; // shared token no longer accepted

  if (!sharedToken) {
    // No shared token configured. A secret-bearing route (or prod) must fail CLOSED — "not configured"
    // must never serve tenant-admin credentials to an unauthenticated caller.
    if (secretBearing || prod) return { action: "reject", status: 503 };
    return { action: "pass" }; // dev/tunnel convenience for non-secret routes, unchanged from today
  }

  if (!bearer || bearer !== sharedToken) return { action: "reject", status: 401 };
  return { action: "pass" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx tsx --test lib/auth/edge-runner-auth.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Rewire `middleware.ts` to use the decision helper**

In `web/middleware.ts`, replace the `if (isRunnerApi(pathname)) { ... }` block (`:41-59`) with:

```ts
  if (isRunnerApi(pathname)) {
    const auth = req.headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const decision = edgeRunnerAuthDecision({
      bearer,
      sharedToken: process.env.RUNNER_API_TOKEN,
      requirePerAgent: process.env.RUNNER_REQUIRE_PER_AGENT === "true",
      secretBearing: isSecretBearing(pathname),
      prod: process.env.NODE_ENV === "production" || process.env.RUNNER_AUTH_REQUIRED === "true",
    });
    if (decision.action === "reject") {
      const msg = decision.status === 503 ? "runner auth not configured" : "unauthorized";
      return NextResponse.json({ error: msg }, { status: decision.status });
    }
    return NextResponse.next();
  }
```

Add to the imports at `:19`:

```ts
import { edgeRunnerAuthDecision } from "./lib/auth/edge-runner-auth";
```

- [ ] **Step 6: Typecheck + full test run**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add web/lib/auth/edge-runner-auth.ts web/lib/auth/edge-runner-auth.test.ts web/middleware.ts
git commit -m "feat(agent-auth): edge admits per-agent tokens, rejects shared after cutover

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Service — remote token refresh + heartbeat mint/deliver/confirm

**Files:**
- Modify: `web/lib/jobs/runner-service.ts` (add `requestTokenRefresh`; extend `heartbeat` at `:385`)
- Test: `web/lib/jobs/agent-token-refresh.test.ts`

**Interfaces:**
- Consumes: `generateAgentToken` (Task 2); `AuthedAgent.via` (Task 3).
- Produces:
  - `requestTokenRefresh(agentId, actor): Promise<{ id: string }>` — sets `tokenRefreshRequested=true` (+`RequestedAt/By`, clears `tokenRefreshDeliveredAt`). Mirrors `requestUpdate` (`:516`).
  - `heartbeat(...)` gains a trailing param `authVia?: "per-agent" | "shared" | null` and its return type gains `provisionToken?: string`. When `tokenRefreshRequested` is set, it mints, stores hash+prefix, stamps `tokenProvisionedAt` + `tokenRefreshDeliveredAt`, clears the flag, and returns `provisionToken` once. When `authVia === "per-agent"`, it stamps `tokenConfirmedAt` (and `tokenRotatedAt` if already confirmed).
  - Consumed by Task 6 (heartbeat route), Task 9 (UI action).

- [ ] **Step 1: Write the failing test**

Create `web/lib/jobs/agent-token-refresh.test.ts`. This tests the two pure decisions the heartbeat makes, extracted so they're unit-testable without a live DB. First define the helper the implementation will expose:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTokenRefresh, planTokenConfirm } from "./agent-token-refresh";
import { isAgentToken } from "@/lib/runner/agent-token";

test("planTokenRefresh mints a new token when a refresh is armed", () => {
  const plan = planTokenRefresh({ tokenRefreshRequested: true });
  assert.ok(plan, "a plan is produced");
  assert.ok(isAgentToken(plan!.token), "minted token is agt_-prefixed");
  assert.equal(plan!.update.tokenPrefix, plan!.token.slice(0, 12));
  assert.equal(plan!.update.tokenRefreshRequested, false, "flag is consumed");
  assert.ok(plan!.update.tokenProvisionedAt instanceof Date);
  assert.ok(plan!.update.tokenRefreshDeliveredAt instanceof Date);
});

test("planTokenRefresh does nothing when no refresh is armed", () => {
  assert.equal(planTokenRefresh({ tokenRefreshRequested: false }), null);
});

test("planTokenConfirm stamps confirmedAt on first per-agent auth", () => {
  const plan = planTokenConfirm({ via: "per-agent", tokenConfirmedAt: null });
  assert.ok(plan?.tokenConfirmedAt instanceof Date);
  assert.equal("tokenRotatedAt" in (plan ?? {}), false, "not a rotation on first confirm");
});

test("planTokenConfirm stamps rotatedAt when an already-confirmed agent re-auths on a new token", () => {
  const plan = planTokenConfirm({ via: "per-agent", tokenConfirmedAt: new Date("2026-01-01") });
  assert.ok(plan?.tokenRotatedAt instanceof Date);
});

test("planTokenConfirm does nothing for a shared-token heartbeat", () => {
  assert.equal(planTokenConfirm({ via: "shared", tokenConfirmedAt: null }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/jobs/agent-token-refresh.test.ts`
Expected: FAIL — cannot find module `./agent-token-refresh`.

- [ ] **Step 3: Write the pure helper**

Create `web/lib/jobs/agent-token-refresh.ts`:

```ts
// Pure decisions the heartbeat makes for per-agent token lifecycle, split out so they're unit-testable
// without a live DB. The service applies the returned `update` object to the Agent row.
import { generateAgentToken } from "@/lib/runner/agent-token";

export function planTokenRefresh(agent: { tokenRefreshRequested: boolean }):
  | { token: string; update: { tokenHash: string; tokenPrefix: string; tokenProvisionedAt: Date; tokenRefreshRequested: false; tokenRefreshDeliveredAt: Date } }
  | null {
  if (!agent.tokenRefreshRequested) return null;
  const { token, prefix, hash } = generateAgentToken();
  const now = new Date();
  return {
    token,
    update: { tokenHash: hash, tokenPrefix: prefix, tokenProvisionedAt: now, tokenRefreshRequested: false, tokenRefreshDeliveredAt: now },
  };
}

export function planTokenConfirm(agent: { via: "per-agent" | "shared" | null | undefined; tokenConfirmedAt: Date | null }):
  | { tokenConfirmedAt: Date }
  | { tokenRotatedAt: Date; tokenConfirmedAt: Date }
  | null {
  if (agent.via !== "per-agent") return null;
  const now = new Date();
  if (agent.tokenConfirmedAt) return { tokenRotatedAt: now, tokenConfirmedAt: now };
  return { tokenConfirmedAt: now };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx tsx --test lib/jobs/agent-token-refresh.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add `requestTokenRefresh` to the service**

In `web/lib/jobs/runner-service.ts`, immediately after `requestUpdate` (ends `:529`), add:

```ts
    // Operator action: arm a per-agent token refresh (joint->individual, or rotate). Mirrors
    // requestUpdate — the next heartbeat mints + delivers the token, then clears the flag.
    async requestTokenRefresh(agentId: string, actor: ActorInput = "ui"): Promise<{ id: string }> {
      const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } });
      if (!agent) throw new HttpError(404, "unknown agent");
      const who = resolveActor(actor);
      await db.agent.update({
        where: { id: agentId },
        data: { tokenRefreshRequested: true, tokenRefreshRequestedAt: new Date(), tokenRefreshRequestedBy: displayActor(who.actor), tokenRefreshDeliveredAt: null },
      });
      await db.auditLog.create({ data: { actor: who.actor, userId: who.userId, action: "agent.token_refresh.request", detail: { agentId } } });
      return { id: agentId };
    },
```

(If `displayActor`/`resolveActor` names differ, match the exact usage in `requestUpdate` at `:516-529`.)

- [ ] **Step 6: Extend `heartbeat` to mint/deliver/confirm**

In `web/lib/jobs/runner-service.ts`:

1. Change the signature at `:385` to add a trailing param and widen the return type:

```ts
    async heartbeat(agentId: string, version?: string | null, semver?: string | null, startedAt?: string | null, capabilities?: string[] | null, appUrl?: string | null, migrateError?: string | null, authVia?: "per-agent" | "shared" | null): Promise<{ ok: true; enabled: boolean; update: boolean; restart: boolean; discover: boolean; migrate: { appUrl: string } | null; provisionToken?: string }> {
```

2. Add `tokenRefreshRequested: true, tokenConfirmedAt: true` to the `select` on the agent lookup at `:386`.

3. At the point where the method assembles its return value (after the existing `update`/`restart`/`discover`/`migrate` computations, before `return`), add:

```ts
      // Per-agent token lifecycle. Deliver an armed refresh once; confirm on a per-agent heartbeat.
      let provisionToken: string | undefined;
      const refresh = planTokenRefresh({ tokenRefreshRequested: agent.tokenRefreshRequested });
      if (refresh) {
        // Atomic consume so overlapping heartbeats can't both mint.
        const consumed = await db.agent.updateMany({ where: { id: agentId, tokenRefreshRequested: true }, data: refresh.update });
        if (consumed.count > 0) provisionToken = refresh.token;
      }
      const confirm = planTokenConfirm({ via: authVia, tokenConfirmedAt: agent.tokenConfirmedAt });
      if (confirm) await db.agent.update({ where: { id: agentId }, data: confirm }).catch(() => {});
```

4. Add `provisionToken` to the returned object.

5. Add the import at the top of the file:

```ts
import { planTokenRefresh, planTokenConfirm } from "./agent-token-refresh";
```

- [ ] **Step 7: Typecheck + full test run**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: PASS. (Existing callers of `heartbeat` still compile — the new param is optional.)

- [ ] **Step 8: Commit**

```bash
git add web/lib/jobs/runner-service.ts web/lib/jobs/agent-token-refresh.ts web/lib/jobs/agent-token-refresh.test.ts
git commit -m "feat(agent-auth): service mints/delivers/confirms per-agent tokens via heartbeat

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire runner-API routes to `authenticateAgent` + the cross-client regression test

**Files:**
- Modify: `web/app/api/jobs/claim/route.ts`, `web/app/api/jobs/[id]/credential/route.ts`, `web/app/api/jobs/[id]/result/route.ts`, `web/app/api/jobs/[id]/progress/route.ts`, `web/app/api/agents/heartbeat/route.ts`, `web/app/api/agents/ad-objects/route.ts`, and the `/api/runner/conn-tests/*` + `/api/runner/cloud-groups/*` route files.
- Test: `web/lib/jobs/runner-cross-client.test.ts`

**Interfaces:**
- Consumes: `authenticateAgent` (Task 3), the service methods (unchanged signatures).
- Produces: every runner-API route derives `agentId` from the authenticated token, not the body. No service-method signatures change — they simply now receive a trustworthy id.

- [ ] **Step 1: Write the failing regression test (the vulnerability, pinned shut)**

Create `web/lib/jobs/runner-cross-client.test.ts`. Because route handlers are outside the test glob, this proves the guarantee at the composition seam: `authenticateAgent` returns the *token's* agent (not the body's), and `brokerCredential` 403s when the authenticated agent isn't the job's assignee.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { generateAgentToken } from "@/lib/runner/agent-token";
import { makeRunnerService } from "./runner-service";
import { HttpError } from "./types";

const req = (bearer: string) => ({ headers: { get: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${bearer}` : null) } });

test("agent A's token cannot authenticate as central/agent B (cross-client claim is impossible)", async () => {
  const tA = generateAgentToken();
  const db = {
    agent: {
      findFirst: async ({ where }: any) =>
        where.tokenPrefix === tA.prefix ? { id: "agentA", clientId: "clientA", enabled: true, tokenHash: tA.hash } : null,
    },
  } as any;
  // Caller presents A's token but claims to be the central runner (clientId null → all clients).
  const authed = await authenticateAgent(db, req(tA.token), "central-agent");
  assert.equal(authed.id, "agentA");
  assert.equal(authed.clientId, "clientA"); // NOT null — cannot escalate to all-clients
});

test("brokerCredential refuses a job the authenticated agent is not assigned to", async () => {
  const db = {
    job: { findUnique: async () => ({ status: "running", assignedAgentId: "agentB", request: { secretNames: ["m365"] }, case: { clientId: "clientB", secretOverrides: null, client: { parentId: null } } }) },
    agent: { findUnique: async () => ({ id: "agentA", enabled: true }) },
  } as any;
  const svc = makeRunnerService(db);
  // authenticated as agentA (from its token), but the job belongs to agentB → 403
  await assert.rejects(() => svc.brokerCredential("job1", "agentA", "m365"), (e: any) => e instanceof HttpError && e.status === 403);
});
```

- [ ] **Step 2: Run test to verify it fails or errors**

Run: `cd web && npx tsx --test lib/jobs/runner-cross-client.test.ts`
Expected: the first test PASSES already (proves `authenticateAgent` is sound); the second may need the fake `db` shape adjusted to match `brokerCredential`'s actual `select` — run it and align the fake with `runner-service.ts:1114`. Expected end state: both PASS.

- [ ] **Step 3: Wire the claim route**

Replace `web/app/api/jobs/claim/route.ts` body of `POST` so identity comes from the token:

```ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { authenticateAgent } from "@/lib/auth/agent-auth";
import { HttpError } from "@/lib/jobs/types";

export async function POST(request: Request) {
  let body: { agentId?: unknown; batchSize?: unknown; version?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const n = Number(body.batchSize);
  const batchSize = Number.isFinite(n) ? Math.max(1, Math.min(25, Math.floor(n))) : 5;
  const version = typeof body.version === "string" ? body.version : null;
  try {
    const authed = await authenticateAgent(db, request, typeof body.agentId === "string" ? body.agentId : null);
    const jobs = await makeRunnerService(db).claim(authed.id, batchSize, version);
    return NextResponse.json(jobs);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Wire the remaining routes identically**

For each of `credential`, `result`, `progress` (job `[id]` routes), `heartbeat`, `ad-objects`, and the `conn-tests` (`claim`, `[id]/credential`, `[id]/result`) + `cloud-groups` (`claim`, `result`) routes: call `authenticateAgent(db, request, <body agentId>)` and pass `authed.id` into the service method wherever the body `agentId` was used. For the heartbeat route (`web/app/api/agents/heartbeat/route.ts:26`), also pass `authed.via` as the new trailing arg:

```ts
    const authed = await authenticateAgent(db, request, body.agentId as string);
    const out = await makeRunnerService(db).heartbeat(authed.id, version, semver, startedAt, capabilities, appUrl, migrateError, authed.via);
```

Keep each route's existing 422 validation for its other fields. Do NOT trust `body.agentId` for anything except the `claimedAgentId` hint passed to `authenticateAgent`.

- [ ] **Step 5: Typecheck + full test suite**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/app/api/jobs web/app/api/agents web/app/api/runner web/lib/jobs/runner-cross-client.test.ts
git commit -m "feat(agent-auth): every runner route derives identity from the token, not the body

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: New enrollments mint a per-agent token

**Files:**
- Modify: `web/lib/jobs/runner-service.ts:317-334` (`enroll`)
- Modify: `web/app/api/agents/route.ts:57-59` (return the token)
- Modify: `web/app/api/runner/install.ps1/route.ts` (bake `-AgentToken` instead of relying on the shared token)
- Test: extend `web/lib/jobs/agent-token-refresh.test.ts` or add `web/lib/jobs/enroll-token-mint.test.ts`

**Interfaces:**
- Consumes: `generateAgentToken` (Task 2).
- Produces: `enroll(...)` returns `{ id, scope, clientId, agentToken: string }`; a freshly enrolled agent has `tokenHash`/`tokenPrefix`/`tokenConfirmedAt` set and starts on per-agent auth (never uses the shared token).

- [ ] **Step 1: Write the failing test**

Create `web/lib/jobs/enroll-token-mint.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAgentToken, verifyToken } from "@/lib/runner/agent-token";

// enroll() must persist a hash and hand back a matching plaintext token exactly once.
test("enroll mints a per-agent token whose plaintext matches the stored hash", async () => {
  let stored: any = null;
  const db = {
    client: { findUnique: async () => ({ id: "clientA" }) },
    agent: { create: async ({ data, select }: any) => { stored = data; return { id: "agentX", scope: data.scope, clientId: data.clientId }; } },
    auditLog: { create: async () => ({}) },
  } as any;
  const { makeRunnerService } = await import("./runner-service");
  const out = await makeRunnerService(db).enroll({ name: "dc1", scope: "client_network", clientSlug: "client-a" });
  assert.ok(isAgentToken(out.agentToken), "returns an agt_ token");
  assert.ok(stored.tokenHash && stored.tokenPrefix, "persists hash + prefix");
  assert.equal(verifyToken(out.agentToken, stored.tokenHash), true, "plaintext matches stored hash");
  assert.ok(stored.tokenConfirmedAt, "new agent starts confirmed on per-agent auth");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/jobs/enroll-token-mint.test.ts`
Expected: FAIL — `out.agentToken` is undefined.

- [ ] **Step 3: Mint in `enroll`**

In `web/lib/jobs/runner-service.ts`, change `enroll` (`:317-334`):

```ts
    async enroll(input: { name: string; scope: AgentScope; clientSlug?: string | null }): Promise<{ id: string; scope: AgentScope; clientId: string | null; agentToken: string }> {
      let clientId: string | null = null;
      const slug = input.clientSlug?.trim() || null;
      if (slug) {
        const c = await db.client.findUnique({ where: { slug }, select: { id: true } });
        if (!c) throw new HttpError(404, `unknown client ${slug}`);
        clientId = c.id;
      }
      if (input.scope === "client_network" && !clientId) throw new HttpError(422, "a client_network agent must be bound to a client");
      const { token, prefix, hash } = generateAgentToken();
      const now = new Date();
      const agent = await db.agent.create({
        data: { name: input.name, scope: input.scope, clientId, lastSeenAt: now, tokenHash: hash, tokenPrefix: prefix, tokenProvisionedAt: now, tokenConfirmedAt: now },
        select: { id: true, scope: true, clientId: true },
      });
      await db.auditLog.create({ data: { actor: "system", action: "agent.enroll", clientId, detail: { agentId: agent.id, scope: agent.scope } } });
      return { ...agent, agentToken: token };
    },
```

Add the import at the top of `runner-service.ts` (if Task 5 didn't already): `import { generateAgentToken } from "@/lib/runner/agent-token";`

- [ ] **Step 4: Return the token from the enroll route + installer**

In `web/app/api/agents/route.ts`, the `enroll` result already flows through `NextResponse.json(out, { status: 201 })` (`:59`) — `agentToken` rides along automatically.

In `web/app/api/runner/install.ps1/route.ts`: after the `POST /api/agents` call that captures the agent id (`:163-167`), capture `agentToken` from the response and write it to the machine env / launcher the same way `RUNNER_API_TOKEN` is handled (`:173-176`), e.g. set `$AgentToken = $resp.agentToken` and pass `-AgentToken $AgentToken` when launching (Task 8 adds the runner param). Keep baking `$ApiToken` too so a mid-migration installer still works, but prefer `-AgentToken`.

- [ ] **Step 5: Run test + typecheck**

Run: `cd web && npx tsx --test lib/jobs/enroll-token-mint.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add web/lib/jobs/runner-service.ts web/app/api/agents/route.ts web/app/api/runner/install.ps1/route.ts web/lib/jobs/enroll-token-mint.test.ts
git commit -m "feat(agent-auth): new enrollments mint a per-agent token

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Runner — accept, adopt, and use the per-agent token

**Files:**
- Modify: `runner/Start-IamRunner.ps1` (param block `:12-14`; bearer set at `:1940`/`:2055`/`:2161`; heartbeat body near `:3227`; response handling after it; self-rewrite launcher at `:2100-2123`)
- Test: `runner/tests/AgentToken.Tests.ps1`

**Interfaces:**
- Consumes: the heartbeat `provisionToken` field (Task 5), `-AgentToken` baked by the installer (Task 7).
- Produces: a runner that prefers `-AgentToken` as its bearer, reports `authMode` in its heartbeat, and on `provisionToken` persists the new token, switches its bearer, drops the shared token, and re-execs.

- [ ] **Step 1: Add the `-AgentToken` param and bearer selection**

In the param block (`:12-14`), after `[string]$ApiToken = $env:RUNNER_API_TOKEN,` add:

```powershell
    [string]$AgentToken = $env:RUNNER_AGENT_TOKEN,   # per-agent token (preferred); falls back to $ApiToken
```

Introduce a single bearer accessor used everywhere a bearer is set (replace the three `if ($ApiToken) { ... "Bearer $ApiToken" }` sites at `:1940`, `:2055`, `:2161`):

```powershell
function Get-CtgBearer { if ($script:AgentToken) { $script:AgentToken } else { $script:ApiToken } }
# ... at each header-building site:
$bearer = Get-CtgBearer
if ($bearer) { $headers['Authorization'] = "Bearer $bearer" }
```

- [ ] **Step 2: Report auth mode in the heartbeat body**

Where `$hbBody` is built before `:3227`, add an `authMode` field so the app can confirm:

```powershell
$hbBody = @{ agentId = $AgentId; version = $buildId; semver = $semver; startedAt = $bootIso; capabilities = $capsJson; appUrl = $AppUrl; authMode = (if ($script:AgentToken) { 'per-agent' } else { 'shared' }) }
```

(The app does not need `authMode` to confirm — it infers `via` server-side from the token used — but sending it makes the Agents page display accurate before the first per-agent call. Optional; keep if it doesn't complicate the body.)

- [ ] **Step 3: Adopt a delivered token on heartbeat response**

After the `$hb = Invoke-AppApi POST '/api/agents/heartbeat' $hbBody` line (`:3227`) and alongside the existing `$hb.update` / `$hb.restart` / `$hb.migrate` handling, add:

```powershell
if ($hb.provisionToken) {
    Write-Host "token: received a per-agent token — adopting and restarting" -ForegroundColor Yellow
    $script:AgentToken = [string]$hb.provisionToken
    [Environment]::SetEnvironmentVariable('RUNNER_AGENT_TOKEN', $script:AgentToken, 'Machine')
    $env:RUNNER_AGENT_TOKEN = $script:AgentToken
    # Drop the shared token so a migrated agent never falls back to it.
    [Environment]::SetEnvironmentVariable('RUNNER_API_TOKEN', $null, 'Machine')
    Restart-CtgSelf -Reason 'token-adopt'   # re-exec so the launcher/env is clean (reuses :2084-2142)
}
```

Ensure the launcher-rewrite path (`:2100-2123`) writes `-AgentToken` into the private, non-world-readable launcher file the same way it writes `-ApiToken` today, and stops writing `-ApiToken` once `$AgentToken` is set.

- [ ] **Step 4: Write the Pester test**

Create `runner/tests/AgentToken.Tests.ps1`:

```powershell
. "$PSScriptRoot/TestHelpers.ps1"  # match how sibling tests bootstrap; see ModuleManifests.Tests.ps1

Describe "Get-CtgBearer" {
  It "prefers the per-agent token over the shared token" {
    $script:AgentToken = 'agt_abc'; $script:ApiToken = 'shared-xyz'
    Get-CtgBearer | Should -Be 'agt_abc'
  }
  It "falls back to the shared token when no per-agent token is set" {
    $script:AgentToken = ''; $script:ApiToken = 'shared-xyz'
    Get-CtgBearer | Should -Be 'shared-xyz'
  }
}

Describe "provisionToken adoption" {
  It "switches the bearer to a delivered token" {
    $script:AgentToken = ''; $script:ApiToken = 'shared-xyz'
    # simulate the heartbeat-response branch (extract it into a testable function Adopt-CtgToken if needed)
    $hb = @{ provisionToken = 'agt_new' }
    if ($hb.provisionToken) { $script:AgentToken = [string]$hb.provisionToken }
    Get-CtgBearer | Should -Be 'agt_new'
  }
}
```

If `Get-CtgBearer` / adoption can't be reached from test scope inline, extract them into a small dot-sourced helper (as other runner logic is) so Pester can load them. Follow the loading pattern in `runner/tests/ModuleManifests.Tests.ps1`.

- [ ] **Step 5: Run the Pester test**

Run: `~/.local/pwsh/pwsh -Command "Invoke-Pester -Path runner/tests/AgentToken.Tests.ps1 -Output Detailed"`
Expected: PASS. (pwsh is at `~/.local/pwsh/pwsh`, not on PATH — see memory: runner-pwsh-testing.)

- [ ] **Step 6: Commit**

```bash
git add runner/Start-IamRunner.ps1 runner/tests/AgentToken.Tests.ps1
git commit -m "feat(agent-auth): runner prefers per-agent token, adopts delivered tokens, drops shared

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Agents UI — remote "switch to individual tokens" + "rotate" + status

**Files:**
- Modify: `web/app/agents/actions.ts` (add `requestAgentTokenRefresh`, `switchAllToPerAgentTokens`, `rotateAllTokens`)
- Modify: `web/app/agents/_lib/loader.ts` (select the new token fields into the view model)
- Modify: `web/app/agents/_components/agents-view.tsx` (auth column + status chip + buttons + fleet banner)

**Interfaces:**
- Consumes: `requestTokenRefresh` (Task 5) and the new `Agent.token*` fields (Task 1).
- Produces: operator-visible remote actions; no new interface consumed downstream.

- [ ] **Step 1: Add the server actions**

In `web/app/agents/actions.ts`, mirroring `requestAgentUpdate` (`:103`) and `updateAllOutdatedAgents` (`:242`):

```ts
export async function requestAgentTokenRefresh(id: string) {
  const me = await requireOperator();               // match the auth helper used by requestAgentUpdate
  await makeRunnerService(db).requestTokenRefresh(id, auditActor(me, "ui"));
  revalidatePath("/agents");                          // match the revalidate call in the sibling actions
}

export async function switchAllToPerAgentTokens() {
  const me = await requireOperator();
  const svc = makeRunnerService(db);
  // Every enabled, non-deleted agent still on the shared token (tokenConfirmedAt is null).
  const ids = (await db.agent.findMany({ where: { enabled: true, deletedAt: null, tokenConfirmedAt: null }, select: { id: true } })).map((a) => a.id);
  let queued = 0;
  for (const id of ids) { try { await svc.requestTokenRefresh(id, auditActor(me, "ui")); queued++; } catch { /* skip */ } }
  revalidatePath("/agents");
  return { queued };
}

export async function rotateAllTokens() {
  const me = await requireOperator();
  const svc = makeRunnerService(db);
  const ids = (await db.agent.findMany({ where: { enabled: true, deletedAt: null }, select: { id: true } })).map((a) => a.id);
  let queued = 0;
  for (const id of ids) { try { await svc.requestTokenRefresh(id, auditActor(me, "ui")); queued++; } catch { /* skip */ } }
  revalidatePath("/agents");
  return { queued };
}
```

Match the exact auth/actor/revalidate calls used by the existing actions in this file (read `:103-114` and `:242-260` and copy their shape precisely).

- [ ] **Step 2: Surface the fields in the loader**

In `web/app/agents/_lib/loader.ts`, add to the agent `select`: `tokenConfirmedAt`, `tokenRefreshRequested`, `tokenRefreshRequestedAt`, `tokenRefreshRequestedBy`, `tokenRefreshDeliveredAt`, and map them into the `AgentVM` (add the matching fields to the `AgentVM` type in `agents-view.tsx:40-55`, as ISO strings / booleans like the existing `updateRequested*` fields).

- [ ] **Step 3: Add the auth status + buttons in the view**

In `web/app/agents/_components/agents-view.tsx`:
- Add an **Auth** column rendering `per-agent ✓` when `tokenConfirmedAt` is set, else `shared`, with a `requested → delivered → confirmed` chip computed exactly like the `updateChip`/`restartChip` helpers (`:100`, `:119`) but reading the `tokenRefresh*` fields.
- Add a per-row **Switch to individual token** button (shown when `!tokenConfirmedAt`) and **Rotate token** (shown when `tokenConfirmedAt`), both calling `requestAgentTokenRefresh(a.id)`.
- Add a fleet toolbar button **"Switch all to individual tokens"** calling `switchAllToPerAgentTokens()` and **"Rotate all"** calling `rotateAllTokens()`, next to the existing "Update all" control (`:433`).
- Add a banner: count `agents.filter(a => a.tokenConfirmedAt).length` of `agents.length` → "X/Y agents on per-agent auth — cutover available at Y/Y."

- [ ] **Step 4: Typecheck + build the web app**

Run: `cd web && npx tsc --noEmit`
Expected: no type errors. (Do NOT run `next build` while a dev server is live — see memory: nextjs-build-vs-dev-gotcha.)

- [ ] **Step 5: Manual verification (dev)**

Follow the web-dev verify recipe (memory: web-dev-verify-recipe): worktree dev server + minted DB session + site cookie. Load `/agents`, confirm the Auth column, the per-agent + fleet buttons, and the banner render. Click "Switch to individual token" on a test agent and confirm the chip goes to "queued".

- [ ] **Step 6: Commit**

```bash
git add web/app/agents
git commit -m "feat(agent-auth): Agents page — remote switch-to-individual + rotate + auth status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Version bump, changelog, docs/memory, PR

**Files:**
- Modify: `runner/VERSION`
- Create: `web/lib/changelog/entries/<new-entry>.ts` + register in `web/lib/changelog/entries/_registry.ts`
- Modify: `docs/RUNNER_PROTOCOL.md` (document the per-agent bearer + `provisionToken` heartbeat field)

**Interfaces:** none (release hygiene).

- [ ] **Step 1: Bump the runner version**

Read `runner/VERSION`, bump the **minor** (backward compatible). E.g. `1.94.0` → `1.95.0`. Write the new value.

- [ ] **Step 2: Add a changelog entry**

Get the Eastern timestamp on a 15-minute boundary:

Run: `TZ=America/New_York date +"%Y-%m-%d %H:%M"`

Create a new file under `web/lib/changelog/entries/` following the shape of the newest existing entry there (read one first), with the rounded time, and register it in `_registry.ts`. Content: "Runners now authenticate with a per-agent token instead of the shared key; switch the fleet over and rotate tokens remotely from the Agents page."

- [ ] **Step 3: Update the protocol doc**

In `docs/RUNNER_PROTOCOL.md`, document: the `Authorization: Bearer <per-agent-token>` scheme, that identity is derived from the token (body `agentId` is a hint only), the `tokenRefreshRequested`/`provisionToken` heartbeat exchange, and the `RUNNER_REQUIRE_PER_AGENT` cutover flag.

- [ ] **Step 4: Full test suite + typecheck**

Run: `cd web && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit + push + draft PR**

```bash
git add runner/VERSION web/lib/changelog docs/RUNNER_PROTOCOL.md
git commit -m "chore(agent-auth): runner version bump, changelog, protocol doc

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push -u origin worktree-per-agent-runner-auth
gh pr create --draft --title "Per-agent runner authentication" --body "$(cat <<'EOF'
Replaces the fleet-wide shared RUNNER_API_TOKEN + self-asserted body agentId with per-agent opaque tokens (hashed at rest), resolved in-handler so an agent's clientId comes from its authenticated Agent row. Joint->individual migration and rotation are remote, zero-touch operator actions delivered via the heartbeat push-down pattern; hard cutover via RUNNER_REQUIRE_PER_AGENT.

Spec: docs/superpowers/specs/2026-07-22-per-agent-runner-auth-design.md
Plan: docs/superpowers/plans/2026-07-22-per-agent-runner-auth.md

**NEEDS DEPLOY:** migration (additive, nullable) + runner build. Deploy app → set RUNNER_PER_AGENT_EDGE_ENABLED=true → deploy runner (dual-mode) → "Switch all to individual tokens" on /agents → watch 200/200 → set RUNNER_REQUIRE_PER_AGENT=true → rotate/retire RUNNER_API_TOKEN.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Update memory**

Add a memory file for this feature (per the memory conventions) noting: per-agent opaque token hashed at rest; `authenticateAgent` derives identity from the token; remote switch/rotate via heartbeat `provisionToken`; `RUNNER_REQUIRE_PER_AGENT` cutover; runner 1.95.0 + migration NEED DEPLOY; the rollout sequence.

---

## Self-review

**Spec coverage:**
- Core change (identity from token) → Tasks 3, 6. ✓
- Data model → Task 1. ✓
- `authenticateAgent` (per-agent + shared + confirmed-refuses-fallback + REQUIRE_PER_AGENT) → Task 3. ✓
- Middleware coarse gate → Task 4. ✓
- Remote provisioning + rotation via heartbeat → Tasks 5, 9. ✓
- Rollout window mitigation (confirmed refuses fallback) → Task 3 (test + impl). ✓
- Cutover flag → Tasks 3, 4. ✓
- Agents UI (switch/rotate/status/banner) → Task 9. ✓
- Runner changes → Task 8. ✓
- New enrollments on per-agent auth → Task 7. ✓
- Testing incl. the cross-client regression → Task 6 + per-task unit tests. ✓
- Version bump, changelog, docs, memory → Task 10. ✓

**Type consistency:** `AuthedAgent { id, clientId, via }` is produced in Task 3 and consumed unchanged in Task 6; `heartbeat`'s new `authVia` param (Task 5) matches `authed.via` (Task 6); `planTokenRefresh`/`planTokenConfirm` names match between Task 5 impl and its test; `generateAgentToken`/`tokenPrefix`/`verifyToken`/`isAgentToken` names match across Tasks 2, 3, 5, 7. ✓

**Placeholder scan:** no TBD/TODO; every code step shows real code. Two deliberate "match the sibling's exact shape" notes (Task 5 `displayActor`/`resolveActor`, Task 9 auth/actor/revalidate) point at concrete existing lines to copy rather than leaving logic unspecified — acceptable because the surrounding code is the authority and the plan names the exact line ranges.
