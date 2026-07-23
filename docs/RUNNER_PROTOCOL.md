# Runner protocol

Runners never receive inbound connections. They poll the app over outbound HTTPS, claim
jobs, execute locally, and post results. The contract is deliberately tiny.

## Enrollment

A runner registers once with an enrollment token, receives an agent id + client cert, and
thereafter authenticates with mutual TLS. `scope=central` for the cloud runner;
`scope=client-network` agents are bound to one `clientId` and only ever see that client's
jobs.

## Authentication (runner-API bearer)

Every runner-API call (`heartbeat`, `claim`, `credential`, `result`, and the connector-test
equivalents) carries `Authorization: Bearer <token>`. Two schemes coexist during the
per-agent migration:

- **Per-agent token** (`agt_...`, opaque, hashed at rest on the `Agent` row) — authoritative.
  `authenticateAgent()` resolves the bearer by its prefix, verifies the hash, and returns
  the agent's own `clientId`. **Identity comes from the token, never from the body** — a
  request body's `agentId` is only a hint (used for the legacy shared-token path below); a
  per-agent-authenticated caller cannot claim/broker as another client by lying in the body.
- **Shared token** (legacy `RUNNER_API_TOKEN`) — identity is the body `agentId`, trusted
  as-is. Allowed only until cutover, and refused outright for any agent that has already
  confirmed a per-agent token (`tokenConfirmedAt` set) even before cutover, so a rollback of
  a single already-migrated agent can't be used to re-widen the fleet-wide shared secret's
  blast radius.

### Remote provisioning and rotation (heartbeat push-down)

Switching an agent to a per-agent token — or rotating an existing one — is a remote,
zero-touch operator action from the Agents page, delivered through the same push-down
pattern as `update`/`restart`/`discover`:

1. Operator action sets `Agent.tokenRefreshRequested = true`.
2. The agent's next `heartbeat` call: the app mints a fresh token (hashed before storage),
   atomically clears `tokenRefreshRequested`, and returns it **once**, in that response only,
   as `provisionToken`. It is never re-delivered — a runner that misses it (crashes before
   persisting) needs a new operator-triggered refresh.
3. **Adopt-and-confirm:** on seeing `provisionToken`, the runner persists it, switches its
   bearer to the per-agent token, drops the shared token, and relaunches
   (`lib/CtgAgentAuth.ps1: Set-CtgAgentToken`). The *next* authenticated call the runner
   makes — ordinarily its next heartbeat — presents the per-agent token, so
   `authenticateAgent` resolves `via: "per-agent"`; the heartbeat handler then sets
   `Agent.tokenConfirmedAt` (first confirmation) or, on a later rotation, both
   `tokenConfirmedAt` and `tokenRotatedAt`. Confirmation is what makes the shared-token
   fallback permanently refused for that agent, independent of the fleet-wide cutover flag.

### Flags

- `RUNNER_REQUIRE_PER_AGENT` — the hard cutover. Once `"true"`, the shared token is refused
  (`401`) on every identity-bearing route regardless of confirmation state; only per-agent
  tokens authenticate. Set this only after the fleet has been switched over and is claiming
  cleanly on individual tokens.
- `RUNNER_PER_AGENT_EDGE_ENABLED` — edge (middleware) safety gate, independent of the
  cutover. The Edge runtime has no DB, so it cannot verify a per-agent token itself — it can
  only decide whether to let the request through to the handler that does. An `agt_`-
  prefixed bearer is admitted at the edge only when this flag is `"true"` **or** cutover
  (`RUNNER_REQUIRE_PER_AGENT=true`) has already happened; until then an `agt_` bearer falls
  through to the same rejection path as an unrecognized token, so a partial deploy (edge
  code shipped, handler validation not yet live) can never admit an unvalidated token. The
  rollout sets this right after the app deploy, before switching any agent over.

## Endpoints (app side)

- `POST /api/agents/heartbeat` — agent reports liveness + version; updates `lastSeenAt`. Response
  `{ ok, enabled, update, restart, discover }`: `update`=re-pull code + relaunch; `restart`=re-exec
  without a pull (operator "Restart" — clears a wedged claim loop); `discover`=run AD OU/group discovery.
  Each flag is consumed atomically (one heartbeat wins).
- `POST /api/jobs/claim` — body `{ agentId }`. Returns up to N `pending` jobs the agent is
  eligible for (matching client + the systems it can execute), atomically flipping them to
  `dispatched`. Cloud runner claims `api` cloud jobs; client agents claim that client's
  on-prem jobs (and browser jobs if Playwright-capable).
- `POST /api/jobs/{id}/credential` — body `{ agentId, secretName }`. App resolves the
  Delinea reference and returns a short-TTL scoped credential. Logged. Never cached by the
  runner.
- `POST /api/jobs/{id}/result` — body `{ status, result, evidence?, error? }`. Sets final
  job state, writes an `AuditLog` row, posts a ServiceNow work note, and advances the case
  (dispatch newly-unblocked jobs, or mark `needs_manual` / `completed` / `failed`).

## Job shape (what a runner receives)

```json
{
  "id": "job_...",
  "action": "onboard",
  "systemKey": "active-directory",
  "mode": "api",
  "client": { "slug": "six-one", "primaryDomain": "61commodities.com", "backbone": "ad-synced" },
  "config": { "ou": "Six One Users", "groups": ["Back Office Users"], "...": "from ClientSystem.config" },
  "secretNames": ["ad-dc"],
  "payload": { "firstName": "Jane", "lastName": "Doe", "...": "case intake fields" },
  "requiresApproval": false,
  "captureEvidence": false
}
```

The runner maps `systemKey` → the `Coretelligent.<System>` module's lifecycle entry point
(`Invoke-Ctg<System>Onboarding` / `...Offboarding`), passes the normalized user, config,
and brokered credential, captures evidence if asked, and returns a structured result.

## Guarantees

- Idempotent: a re-claimed/re-run job must converge to the same state (modules check
  before they change).
- Approval-gated: jobs with `requiresApproval` are not dispatched until an approval record
  exists; the app enforces this, the runner trusts it.
- Auditable: claim, credential fetch, and result each append to `AuditLog`; results also
  post a case work note. Evidence (membership/app snapshots) is attached before any removal.
- Least privilege: a client agent can only claim its own client's jobs and only fetch
  secrets named on those jobs.
