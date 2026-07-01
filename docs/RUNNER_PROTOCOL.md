# Runner protocol

Runners never receive inbound connections. They poll the app over outbound HTTPS, claim
jobs, execute locally, and post results. The contract is deliberately tiny.

## Enrollment

A runner registers once with an enrollment token, receives an agent id + client cert, and
thereafter authenticates with mutual TLS. `scope=central` for the cloud runner;
`scope=client-network` agents are bound to one `clientId` and only ever see that client's
jobs.

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
