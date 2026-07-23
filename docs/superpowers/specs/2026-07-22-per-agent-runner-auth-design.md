# Per-agent runner authentication

Date: 2026-07-22
Status: approved for implementation

## Problem

Every machine endpoint the runner fleet calls is gated by a **single shared bearer token**,
`RUNNER_API_TOKEN` (`web/middleware.ts:42-58`). That same value is baked into every
client's installer and sits on ~200 domain-controller-adjacent hosts
(`web/app/api/runner/install.ps1/route.ts`; `runner/Start-IamRunner.ps1:14` labels it
`# interim shared bearer (until mTLS)`).

Worse, **agent identity is self-asserted, not authenticated.** `agentId` is a request body
field (`web/app/api/jobs/claim/route.ts:15`). `claim()` scopes eligible jobs by *that
agent's* `clientId` (`web/lib/jobs/runner-service.ts:657`), and `brokerCredential()` only
checks `job.assignedAgentId !== agentId` (`runner-service.ts:1116`) — but the caller set
`assignedAgentId` during its own forged claim. So the shared token **plus** any known or
guessable `agentId` (including the central runner's, whose `clientId` is `null` and which
sees **all** clients' jobs) lets any holder claim jobs and broker brokered Delinea
credentials for **any** client.

Given what those credentials are — standing M365 Global Admin app registrations and AD
domain credentials for ~200 tenants — a token lifted from a single client's on-prem host is
a full-fleet compromise. This is the top security blocker before broader rollout.

## Goal

Bind the authenticated transport identity to the agent identity so that **the credential is
the identity**: each agent authenticates with its own secret, the authenticated `Agent` row
is the sole source of `clientId` for scoping, and the request-body `agentId` is no longer
trusted. Cross-client claim/broker becomes structurally impossible, not merely checked.

Provisioning the individual tokens onto the ~200 already-running agents, and rotating them
later, must be **remote, zero-touch operator actions** from the Agents page — no visiting or
RDP-ing each server.

## Non-goals / scope guardrails

- **No mTLS.** Client certificates are the eventual gold standard but need TLS ingress with
  client-cert passthrough that the current tunnel (and the planned Azure ingress) does not
  provide yet. Deferred to a later phase behind the deploy work.
- **No JWT / stateless-verify tokens.** Opaque tokens hashed at rest give instant revocation
  (via the existing `enabled` flag or a rotate) without a refresh/TTL dance.
- **No change to the enrollment design.** The signed HMAC enroll token
  (`web/lib/runner/enroll-token.ts`) that binds a new agent to a `scope`+`client` is already
  correct and stays as-is; it governs *record creation*, this spec governs *runtime auth*.
- **No PKI, no CRL, no key-management service.**
- **No change to job scheduling, dependency gating, or secret resolution** beyond swapping
  the identity source from body `agentId` to the authenticated agent.

## Current behavior (as-built, verified)

- **Edge gate:** `web/middleware.ts:41-58` — `isRunnerApi(pathname)` paths require
  `Authorization: Bearer <RUNNER_API_TOKEN>`; fails closed in prod / for secret-bearing
  routes when the token is unset. Runs in the Edge runtime — **no Prisma / no DB access**.
- **Path classification:** `web/lib/auth/runner-paths.ts` — `isRunnerApi` (bearer-gated:
  `/api/agents/*`, `/api/jobs/claim`, `/api/jobs/<id>/{credential,result,progress}`,
  `/api/runner/*` except bootstrap), `isRunnerBootstrap` (open: manifest/file/installer),
  `isSecretBearing` (fail-closed even in dev).
- **Enrollment:** `POST /api/agents` (`web/app/api/agents/route.ts`) verifies a signed enroll
  token (`verifyEnrollToken`) or a shared `ENROLLMENT_TOKEN` header, then
  `runner-service.ts:enroll()` (317-334) creates the `Agent` row and returns
  `{ id, scope, clientId }`. The runner is configured with `-AgentId <id>`.
- **Identity is a body param:** `claim(agentId, …)` (`runner-service.ts:561`) looks the agent
  up and scopes by `agent.clientId` (657). `brokerCredential(jobId, agentId, …)` (1113)
  checks `job.assignedAgentId !== agentId` (1116) and resolves the secret against
  `job.case.clientId` (1130). Same `assignedAgentId !== agentId` pattern in `recordResult`
  (1545), `recordProgress` (1607), conn-test broker (1363, 1412).
- **`Agent` model** (`web/prisma/schema.prisma:257-313`): already carries the operator-request
  → heartbeat-delivered → confirmed push-down pattern for `updateRequested`,
  `restartRequested`, `migrateRequested` (each with `*RequestedAt/By`, `*DeliveredAt`). This
  spec reuses that exact pattern for token refresh.
- **Runner auth + push-down consumption:** `runner/Start-IamRunner.ps1` — bearer set at
  `:1940` / `:2055` / `:2161`; the launcher embeds `-ApiToken` into a **private,
  non-world-readable** per-launch file (`:2123`); the self-rewrite/re-exec path for
  update/restart/migrate is at `:2100-2123`. The heartbeat already parses response flags and
  acts on them.

## Design

### 1. The core change — collapse identity into the credential

The authenticated agent is derived **solely** from the presented per-agent token. All
`clientId` scoping reads from that authenticated `Agent` row. The request-body `agentId`
becomes advisory: asserted-equal during the dual-mode window, ignored after cutover. To act
as client X's agent you must hold client X's agent's secret.

### 2. Data model — `Agent` additions (additive migration, all nullable, no backfill)

```prisma
tokenHash             String?    // SHA-256 of the per-agent secret (token is high-entropy random)
tokenPrefix           String?    // first 8 chars — INDEXED for O(1) lookup; not secret
tokenProvisionedAt    DateTime?  // last mint+deliver (may be unconfirmed)
tokenConfirmedAt      DateTime?  // set when the agent first authenticates WITH its per-agent token
tokenRotatedAt        DateTime?  // last successful rotate of an already-confirmed token

// Operator-armed remote refresh (mirrors updateRequested/restartRequested/migrateRequested)
tokenRefreshRequested   Boolean   @default(false)
tokenRefreshRequestedAt DateTime?
tokenRefreshRequestedBy String?
tokenRefreshDeliveredAt DateTime?

@@index([tokenPrefix])
```

- **Token format:** `agt_<random>` where `<random>` is 32 bytes base64url (~43 chars).
- **Prefix:** first 8 chars of the full token, used only to locate the row; not a secret.
- **Hash:** `sha256(fullToken)`, compared with `timingSafeEqual` against `tokenHash`. SHA-256
  (not scrypt/bcrypt) is appropriate because the token is high-entropy random, not a
  human-chosen password.
- **Plaintext is never stored.** It is returned exactly once (on delivery) and then only its
  hash persists.

### 3. Server auth layer

**New `web/lib/auth/agent-auth.ts`:**

```ts
authenticateAgent(req): Promise<{ agent: Agent; via: "per-agent" | "shared" }>
```

- Read the `Authorization: Bearer` value.
- If its 8-char prefix matches a `tokenPrefix` and `timingSafeEqual(sha256(token), tokenHash)`
  → `via: "per-agent"`, return that agent. Reject if `!agent.enabled` (instant revoke).
- Else if it equals `RUNNER_API_TOKEN` **and** `RUNNER_REQUIRE_PER_AGENT !== "true"` →
  `via: "shared"` (legacy; identity still comes from the body `agentId`, looked up as today).
- Else `401`.

**Middleware (`web/middleware.ts`):** keeps its coarse role only — is this a runner-API path,
and is *a* bearer present? It runs at the Edge with no DB, so it stops implying it validates
*which* token. When `RUNNER_REQUIRE_PER_AGENT=true` it still can't DB-resolve, so it only
requires a bearer to be present; the handler is authoritative and rejects shared/unknown.
The existing secret-bearing fail-closed behavior is preserved.

**Route handlers** (`claim`, `credential`, `result`, `progress`, heartbeat, `ad-objects`,
conn-test credential broker, cloud-groups claim) call `authenticateAgent(req)` first and pass
the **authenticated agent** into the service layer.

**Service methods** (`claim`, `brokerCredential`, `recordResult`, `recordProgress`, heartbeat,
conn-test broker) take the authenticated agent (or its already-authenticated id) instead of a
raw body `agentId`:

- `brokerCredential`: `job.assignedAgentId !== agent.id → 403` is now a **real** check (the
  caller cannot forge `agent.id`); the secret resolves against `agent.clientId`'s client, and
  a `client_network` agent can never reach another client's secret. The central agent
  (`clientId === null`) retains its legitimate all-clients reach.
- During dual-mode, when `via === "shared"`, the body `agentId` is used (legacy) and an
  `AuditLog` row `agent.auth.legacy_shared` is written so the Agents page / audit can show who
  is still on the shared token.

### 4. Remote provisioning + rotation (one mechanism, armed by an operator action)

Minting a token for the first time (joint→individual) and rotating an existing one are the
**same operation**: mint a new secret, store its hash+prefix, deliver the plaintext once. One
flag drives both.

**Arm (remote, zero-touch):** an operator clicks **"Switch all agents to individual tokens"**
(fleet-wide) or a per-agent **Switch** / **Rotate token** button → sets
`tokenRefreshRequested=true` (+ `RequestedAt/By`) on the targets. No server is touched.

**Deliver (next heartbeat):** if `tokenRefreshRequested` is set, the heartbeat handler mints a
secret, stores `tokenHash`+`tokenPrefix`, sets `tokenProvisionedAt`, clears the flag, stamps
`tokenRefreshDeliveredAt`, and returns `provisionToken: <plaintext>` in the response **once**.

**Adopt (runner):** the runner persists the new token to its private launcher file, switches
the bearer used for all subsequent calls, drops the shared token from the launcher, and
re-execs (the existing self-rewrite path). Its next heartbeat authenticates with the new
token → the handler stamps `tokenConfirmedAt` (and `tokenRotatedAt` if it was already
confirmed).

**Delivery auth:**
- **First provision (joint→individual):** the delivering heartbeat is authenticated by the
  **shared token** (the only credential the agent has yet).
- **Rotate:** the delivering heartbeat is authenticated by the agent's **current per-agent
  token**. Same code path; the only difference is which bearer authenticated the request and
  the UI label.

**Crash safety:** if the runner dies before persisting (never confirms), the flag was already
cleared but `tokenConfirmedAt` stays null; re-arming (or an unconfirmed-stale re-arm) mints a
fresh token — no stored plaintext to leak, old hash simply overwritten.

### 5. Rollout window mitigation + cutover

- **Phase 1 — dual-accept:** on deploy, the handler accepts shared *or* per-agent tokens, but
  the edge admits `agt_` tokens only once `RUNNER_PER_AGENT_EDGE_ENABLED=true` is set (a safety
  gate so no partially-deployed/rolled-back state can admit an unvalidated `agt_` bearer before
  the route handlers are live). Set that flag immediately after the app deploy; live agents keep
  working on the shared token unchanged until an operator arms their refresh.
- **Confirmed agents refuse fallback:** once an agent has `tokenConfirmedAt`, the shared token
  is rejected *for that agent's id* — a migrated agent must never fall back. This shrinks the
  forgeable set to not-yet-migrated agents during the window.
- **Phase 2 — cutover:** operator watches the Agents page reach 200/200 confirmed, then sets
  `RUNNER_REQUIRE_PER_AGENT=true` (shared token now `401` on all identity-bearing routes) and
  rotates/retires `RUNNER_API_TOKEN`.

### 6. Agents UI

- **Auth column** per agent: `shared` / `per-agent ✓ confirmed`, with the familiar
  `requested → delivered → confirmed` status pipeline (identical to the update/restart chips).
- **Fleet actions:** **"Switch all to individual tokens"** (arms refresh on every agent still
  on the shared token) and **"Rotate all"**.
- **Per-agent actions:** **Switch to individual token** / **Rotate token**, plus the existing
  **Disable** (an instant kill — `authenticateAgent` rejects `!enabled`).
- **Fleet banner:** "X/200 agents on per-agent auth — cutover available at 200/200."
- Every action is remote; the only physical/RDP touch that ever remains is the first install
  of a brand-new agent (always true).

### 7. Runner (PowerShell)

- New `-AgentToken` param (separate from the shared `-ApiToken`), stored in the existing
  private, non-world-readable launcher file (`Start-IamRunner.ps1:2123`).
- Bearer selection: prefer `-AgentToken` when present, else `-ApiToken`.
- Heartbeat response handling: on `provisionToken`, persist → switch bearer → drop shared →
  re-exec (reuse the migrate/restart self-rewrite at `:2100-2123`). Same path serves first
  provision and rotate.
- Heartbeat request reports the auth mode / token prefix in use so the app can confirm and
  display it.
- Bump `runner/VERSION` (minor — backward-compatible; a legacy runner keeps using the shared
  token until refreshed).

## Testing

- **The regression test that pins the vulnerability shut** (`runner-cross-client.test.ts`): a
  request carrying agent A's token but body `agentId=B` (or the central agent's id) must
  **not** claim B's jobs or broker any other client's credentials — `clientId` is taken from
  A's authenticated row, and `brokerCredential` 403s on the assigned-agent mismatch.
- **`agent-auth.test.ts`:** correct token resolves to the right agent; wrong token → 401;
  disabled agent → 401; shared token accepted only when `RUNNER_REQUIRE_PER_AGENT !== "true"`;
  timing-safe comparison; prefix collision handled (hash is authoritative).
- **Provisioning/rotation:** arming sets the flag; heartbeat mints+delivers once and clears
  the flag; adoption stamps `tokenConfirmedAt`; a second arm on a confirmed agent rotates and
  stamps `tokenRotatedAt`; unconfirmed-stale re-arm re-mints.
- **Cutover:** with `RUNNER_REQUIRE_PER_AGENT=true`, the shared token → 401 on claim +
  credential; a confirmed per-agent token still works.
- **Confirmed-refuses-fallback:** a confirmed agent presenting the shared token → 401 even in
  dual-mode.
- **Pester (runner):** token-switch persists to the launcher file, re-execs, and prefers the
  per-agent bearer afterward; a runner with no `-AgentToken` still authenticates with the
  shared token.

## Rollout / ops

1. Deploy the migration (nullable columns — safe) and the app.
2. Set `RUNNER_PER_AGENT_EDGE_ENABLED=true` (the edge now admits `agt_` tokens; handlers validate them).
3. Deploy the runner build (dual-mode; no behavior change for live agents until armed).
4. Click **"Switch all to individual tokens"**; watch the Agents page climb to 200/200.
5. Set `RUNNER_REQUIRE_PER_AGENT=true`; rotate/retire `RUNNER_API_TOKEN`.

Migration and runner build both **NEED DEPLOY**. Changelog entry + memory update on ship.

## Sequencing note

This is the predecessor to **project B (signed update bundles)** — both harden the runner
trust boundary — and to the eventual **mTLS phase**, which slots in behind whatever real TLS
ingress the deploy work (project D) provides. Nothing here blocks those; they layer on top.
