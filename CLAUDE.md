# iam-engine — project guide for Claude Code

You are building the IAM lifecycle automation platform for Coretelligent's Remote
Support org. It executes new-user onboarding and user offboarding across ~200 client
orgs by turning each client's runbook into data and running shared executors against it.

Read these in order before writing code: `docs/ARCHITECTURE.md` (how the pieces fit and
why), `docs/DATA_MODEL.md` (entities + the ServiceNow intake mapping),
`docs/RUNNER_PROTOCOL.md` (app↔runner contract), `docs/BUILD_PLAN.md` (phased build).
Every system has a full build spec in `docs/modules/` — start at `docs/modules/_INDEX.md`
(the master catalog + cross-cutting patterns), then read the spec for whichever module you
implement. `docs/modules/_TEMPLATE.md` defines the spec contract.

## What this is, in one paragraph

A central web app (the brain: database, queue, UI) plans a case from a ServiceNow
intake form and a per-client profile, then dispatches each step as a job. Jobs are
executed by PowerShell runners that call shared `Coretelligent.*` modules. Cloud systems
(M365, Google, Mimecast, Adobe…) are handled by a central/cloud runner calling their
APIs directly. On-prem systems (Active Directory, file servers, appliances) are handled
by a lightweight agent installed in the client's network that polls the app over
outbound HTTPS — no inbound firewall changes. Browser automation (Playwright) lives
*inside* the runner as a last-resort executor for the few systems with no API. Secrets
never live in the app or in profiles — only Delinea references; the app brokers
short-lived scoped credentials to runners at execution time.

## Stack (chosen for fast build + the team's PowerShell fluency)

- `web/` — Next.js (App Router, TypeScript) + Prisma + PostgreSQL. Full-stack: React UI,
  API routes, DB. Start with a DB-backed job queue (a `Job` table polled by runners);
  swap to Redis/BullMQ only if throughput demands it.
- `runner/` — PowerShell 7 service. Polls the app, pulls jobs, executes via the
  `Coretelligent.*` modules already in `runner/modules` and `runner/lib`, posts results.
  Same binary runs centrally (cloud-only clients) or as a client-network agent (AD/hybrid).
- `profiles/` — the v2 JSON client profiles (validated against `profiles/_schema.json`).
  These are the seed source for the `Client` + `ClientSystem` rows.

## Conventions

- The profile schema in `profiles/_schema.json` is the source of truth for client config.
  The Prisma models normalize it; `prisma/seed.ts` ingests the JSON into rows.
- Every executor is idempotent — check state before changing it; a re-run after a partial
  failure must be safe. The `Coretelligent.M365` module is the reference implementation.
- Every job writes an `AuditLog` row and a ServiceNow work note. Offboarding destructive
  steps (`requiresApproval`) are gated server-side, not in the UI.
- Manual/browser steps are first-class: a job whose `mode` is `manual` is recorded as a
  checklist item on the case, never silently skipped.
- UI: follow the host design system Claude is given for artifacts (flat, minimal borders,
  sentence case, no gradients). Keep the first build plain; polish later.

## Scope decisions already made (do not widen without asking)

- Build order is volume-weighted: the top-20-by-case-count clients first (see BUILD_PLAN).
- `entra` and `ad-synced`/`ad-standalone` backbones cover most volume; build those paths
  first. Google is one top-20 client (Brighton Park); Mimecast is near-core.
- Out of scope for now: PGLS (ignore entirely), and the "Needs Cleanup / Document Missing
  / N/A" clients. Institute On Aging is offboard-only. Boys & Girls Club (missing offboard
  doc) and Atlanta Opera (doc needs cleanup) are parked until their docs are fixed.

## First commit target

Phase 1 in `docs/BUILD_PLAN.md`: stand up the DB, seed it from `profiles/`, and ship the
clients list with add (onboard a client) and archive (offboard a client) working. Don't
build runners yet — get the brain and the data model solid first.
