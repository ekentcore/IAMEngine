# Architecture

## The core problem

A central service must perform privileged actions across ~200 client tenants. Some live
in the cloud (M365/Entra, Google Workspace, Mimecast, Adobe, Zoom, Slack, Spanning…) and
are reachable by API. Some live inside each client's network behind a firewall (on-prem
Active Directory domain controllers, file servers, the Egnyte Sync Server appliance,
print servers). No central box can reach inside a client's LAN directly. That split is
the whole architectural decision.

## Components

```
ServiceNow intake form ─► Web app (brain) ─► Job queue ─► Runners ─► target systems
                              │                                          │
                         PostgreSQL                              results + evidence
                         (clients, profiles,                            │
                          cases, jobs, audit)  ◄───────────────────────┘
                              │
                         Delinea (secret refs only; short-lived creds brokered at run time)
```

- Web app — Next.js + Postgres. Holds clients, per-client module config (the profile),
  cases (from the intake form), jobs, agents, and the audit log. Plans a case (which
  systems, what order, manual vs api) and enqueues jobs. Serves the dashboard.
- Runner — PowerShell 7 worker. Polls for jobs, executes via the `Coretelligent.*`
  modules, posts results + evidence. One codebase, two deployments (below).
- Delinea — system of record for secrets. The app stores only references (secret ids).
  At execution time it brokers a short-lived, scoped credential to the runner.

## Runtime / execution model — recommendation

Use a hybrid job-runner (agent) model. Do not use browser automation as the transport.

1. Cloud systems → central runner, direct API. A cloud-hosted runner calls Graph,
   Google Admin SDK, Mimecast, Adobe UMAPI, etc. with per-client credentials brokered
   from Delinea. No footprint inside the client network. This covers `entra` and
   `google` backbone clients end to end, and the cloud half of hybrid clients.

2. On-prem systems → client-network agent, outbound-polling. Install one lightweight
   runner on a management host in the client's network (a dedicated jump/management box
   is cleaner than the DC itself, but a DC works). It polls the app over outbound HTTPS,
   pulls only that client's jobs, runs PowerShell locally against AD
   (`New-ADUser`, group changes, `Start-ADSyncSyncCycle`, the offboard evidence/disable
   path), and posts results back. No inbound ports, no firewall changes.

3. Browser automation → inside the runner, last resort. For the handful of API-less
   systems (Egnyte Sync Server appliance, printer address books), Playwright runs inside
   whichever runner already has reach. Browser automation is an executor of last resort,
   never the transport between the app and the client.

This is the ServiceNow MID Server pattern — a service in the client network that polls
the platform over outbound HTTPS and executes work locally — which Coretelligent already
operates, so it's a known quantity to deploy, secure, and support.

### Why not browser-on-the-DC as the mechanism

It was floated as an option. Reject it as the primary transport:

- Brittle: it drives a UI, so any portal change breaks it; APIs are contracts.
- Stateful: it needs a maintained interactive session on the DC.
- Hard to operate: central queueing, retry, idempotency, and concurrency are awkward
  when the unit of work is "drive a browser somebody left logged in."
- Security smell: a general-purpose browser session running automation on a domain
  controller is exactly what a regulated client's auditor will flag.

The agent gives the opposite on every axis: outbound-only connectivity, least-privilege
local execution, structured retry/idempotency, and a clean per-action audit trail.

### The unifying insight

Make the runner always the executor — a central runner for cloud-only clients, a
client-network agent for AD/hybrid clients — and both run the same `Coretelligent.*`
PowerShell modules. The modules become the agent's library; the web app stays a pure
brain (DB + queue + UI); there is exactly one execution path to reason about and test.

## Security posture (matters for the regulated book)

- Agents connect outbound only; mutual TLS, and each job carries a signed, short-TTL token.
- Secrets stay in Delinea. The app brokers a scoped, short-lived credential per job; the
  runner never persists it and it never lands in the DB or a profile.
- Least-privilege service principals per tenant (per-client app registrations / AD
  service accounts), so a compromise is contained to one client.
- Every action → an `AuditLog` row + a ServiceNow work note. Destructive offboard steps
  (`requiresApproval`) are gated server-side and require recorded approval before dispatch.
- Evidence capture (screenshots of group/app membership) is attached to the case before
  removal, as today's offboarding runbooks already require.
