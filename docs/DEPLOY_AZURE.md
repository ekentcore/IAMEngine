# Deploying iam-engine to Azure (target architecture + migration runbook)

> Status: **roadmap, not yet executed.** The portable pieces that make this easy were built first
> (the runner watchdog + `-HealthCheck` liveness signal, semver/hash versioning, "stuck" visibility).
> This doc is the plan to execute when we move off the dev box.

## Why
Today the app runs as `next dev` on a workstation (`192.168.0.x:3000`, exposed via an ngrok/cloudflared
tunnel) and the central runner is a hand-started `nohup` PowerShell process on a Mac. That's fine for
development but has no supervision, no managed TLS/DNS, no backups, and no scaling. Azure gives us a
managed platform that **supervises the runner with a health probe** — which is the durable answer to
"auto-restart a stuck runner": when the runner wedges, the probe fails and the platform relaunches it.

The production execution model is already the one the docs describe (`ARCHITECTURE.md`): a **central
cloud runner** for API/REST systems + **per-client Windows agents** inside each client's LAN for
on-prem systems. Azure realizes that split; it does not change it.

## Target topology

```
                         Azure (one resource group, one region)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Container Apps Environment                                                │
  │   ├─ app  (Next.js)   ── HTTPS, custom domain, managed cert ──┐            │
  │   │     health: /  (readiness/liveness)                       │            │
  │   └─ runner (PowerShell 7, Linux)                             │            │
  │         liveness: exec `pwsh Start-IamRunner.ps1 -HealthCheck`│            │
  │         min 1 replica; KEDA scale on pending-jobs count       │            │
  │  Azure Database for PostgreSQL (Flexible Server)  ◄── both ───┤            │
  │  Key Vault (DB url, Delinea creds, runner token)  ◄── MI ─────┤            │
  │  Log Analytics / App Insights  ◄── logs/metrics/alerts ───────┘            │
  └───────────────────────────▲──────────────────────────────────────────────┘
                              │ outbound HTTPS (poll /api/jobs/claim, heartbeat)
            ┌─────────────────┴───────────────────┐
   per-client Windows agent                per-client Windows agent      …
   (RSAT ActiveDirectory + ADSync,         (on-prem Exchange via Kerberos)
    Task Scheduler + watchdog)             — stays in the client LAN, never moves
```

## Components

### Web app → Azure Container Apps
- Containerize with a multi-stage `Dockerfile` (`node:20` → `next build` → `next start`). `web/package.json`
  already has `build`/`start`.
- Stateless: the DB is the source of truth (sessions live in Postgres). Scale on HTTP load.
- **Stable public HTTPS** with a custom domain + managed certificate. This is the endpoint **every**
  on-prem agent polls (replaces the ngrok tunnel / `AUTH_PUBLIC_ORIGIN`). Set `AUTH_PUBLIC_ORIGIN` to it.
- Health probe: `GET /` (readiness + liveness).

### Postgres → Azure Database for PostgreSQL (Flexible Server)
- Managed backups, optional zone-redundant HA, PgBouncer connection pooling.
- The **job queue stays DB-backed** (the `Job` table polled by `claim()`) — no broker needed. `claim()`
  is atomic (pending→dispatched in one statement), so horizontal runner scale is safe, and the
  stale-lease reclaim already covers a dead replica. (Swap to a broker only if throughput ever demands.)
- `DATABASE_URL` comes from Key Vault. Run `prisma migrate deploy` from CI on each release.

### Central cloud runner → Azure Container Apps (separate app)
- Linux image: `mcr.microsoft.com/powershell` base, with `Microsoft.Graph.*` + `ExchangeOnlineManagement`
  (pin **3.9.2** — see the `ExoModuleVersion` note) preinstalled, plus the `runner/` tree.
- Runs **cloud/REST modules only** — all verified Linux-safe: M365/Entra, Exchange Online (EXO v3 is
  REST-based), Mimecast, Adobe, Google Workspace, Zoom, Spanning, KnowBe4, Egnyte, Jira, HubSpot,
  SentinelOne, Duo, xMatters, LogicMonitor.
- **Liveness probe = the runner's own health check** (built in A1):
  - `exec`: `pwsh /app/Start-IamRunner.ps1 -HealthCheck -AppUrl <self> -AgentId <id>`
  - Set `RUNNER_HEARTBEAT_FILE` to a fixed path and `RUNNER_SUPERVISED=1` (so the in-process watchdog
    defers to the platform). When a job wedges, the heartbeat goes stale → the probe exits 1 → Container
    Apps kills + restarts the replica. **This is the durable "restart when stuck."**
  - Set the probe `failureThreshold`/`periodSeconds` so it trips a bit after `StallTimeoutSeconds` (600s).
- **Scaling:** `minReplicas: 1` to start; later a **KEDA** scaler on a `/api/jobs/pending-count` metric
  (add this tiny endpoint) so replicas scale 1→N with backlog and back. Atomic claim makes N replicas safe.
- **Updates = image deploys** (a new revision), retiring the file-pull self-update for the cloud runner.

### Per-client on-prem agents → unchanged model
- Stay on a Windows host in each client's LAN (need `ActiveDirectory` RSAT + `ADSync` + on-prem Exchange
  over Kerberos — **cannot move to the cloud**). Repoint them to the stable Azure HTTPS endpoint.
- Supervise with a **Windows Service / Task Scheduler restart-on-failure** plus the same A1 watchdog
  (`RUNNER_SUPERVISED=1`, so the watchdog exits and the supervisor relaunches).

### Auth & secrets
- Today: a shared bearer (`RUNNER_API_TOKEN`). Target (already documented in `RUNNER_PROTOCOL.md`):
  - **Cloud runner ↔ app:** Managed Identity / Azure AD token (same trust boundary inside the Container
    Apps env).
  - **On-prem agents:** per-agent enrollment → client cert → **mTLS**.
- **App secrets** (`DATABASE_URL`, Delinea API creds, any runner token) → **Azure Key Vault**, read via
  the app's **Managed Identity** (no secrets in env files / images).
- **Delinea stays the secret store**; the app keeps brokering scoped, short-lived creds per job. Both the
  cloud runner and on-prem agents reach Delinea outbound — no change.

### Versioning (already built) → image tags
- `runner/VERSION` (semver) + the content hash map directly onto deploys: **image tag = `v1.0.0`,
  image label/annotation = git SHA**. The Agents page already shows "v1.0.0 · build <hash>"; the hash
  stays the canonical up-to-date check for the file-pulling on-prem agents.

### Observability
- Container Apps → **Log Analytics / Application Insights**. Alerts on: repeated replica restarts
  (a runner crash-looping), and a job "stuck" (running with no progress > N min — the same signal the
  Agents UI badge uses). This replaces "a human noticed it was offline."

## Migration runbook (cutover)
1. **Provision** (IaC under `infra/`, Bicep or Terraform): resource group, Container Apps environment,
   Flexible Postgres, Key Vault, Log Analytics. Put `DATABASE_URL` + secrets in Key Vault.
2. **Containerize**: add `Dockerfile` (web) and `Dockerfile.runner`; wire a GitHub Actions workflow:
   build + push images tagged `semver+SHA` → `prisma migrate deploy` → deploy revisions.
3. **Data**: `pg_dump` the dev Postgres → restore into Flexible Server (or start clean + reseed from
   `profiles/`). Point the app at the new `DATABASE_URL`.
4. **App up**: deploy the web Container App, bind the custom domain + managed cert, set `AUTH_PUBLIC_ORIGIN`.
5. **Cloud runner up**: deploy the runner Container App with the liveness probe; enroll it as the central
   agent (or migrate the existing `central-mac` agent id). Confirm it claims + runs cloud jobs.
6. **On-prem agents**: repoint each client agent's `-AppUrl` to the new endpoint; confirm heartbeats.
   Issue per-agent certs and turn on mTLS.
7. **Decommission** the ngrok tunnel and the hand-started Mac runner once the cloud runner is steady.

## What explicitly stays on-prem
AD (`Coretelligent.ActiveDirectory`, RSAT), directory sync (`Coretelligent.DirectorySync`,
`Start-ADSyncSyncCycle`), and on-prem/hybrid Exchange (Kerberos). These run on the per-client Windows
agent regardless of where the app/cloud-runner live.

## Open decisions (resolve at execution time)
- Bicep vs Terraform for IaC.
- Container Apps vs App Service for the **web** tier (Container Apps preferred for one consistent
  platform + KEDA; App Service is simpler if we don't want KEDA for the web app).
- Whether the cloud runner self-updates by image deploy only, or also keeps the file-pull path as a
  break-glass.
- mTLS issuer/rotation for on-prem agent certs.
