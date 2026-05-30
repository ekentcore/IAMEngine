# iam-engine

IAM lifecycle automation for Coretelligent Remote Support: onboard new users and offboard
departing ones across ~200 client orgs, by turning each client's runbook into data and
running shared executors against it.

Hand this repo to Claude Code and point it at `CLAUDE.md` first.

```
iam-engine/
├─ CLAUDE.md              ← start here (project guide for Claude Code)
├─ docs/
│  ├─ ARCHITECTURE.md     system design + the runtime/execution-model decision
│  ├─ DATA_MODEL.md       entities + ServiceNow intake-form mapping
│  ├─ RUNNER_PROTOCOL.md  app ↔ runner contract
│  └─ BUILD_PLAN.md       phased build (volume-weighted, top-20 first)
├─ web/                   Next.js + Prisma + Postgres (the brain: DB, API, UI)
│  ├─ prisma/schema.prisma   the database
│  ├─ prisma/seed.ts         ingests profiles/ into rows
│  ├─ lib/orchestrator.ts    case → ordered jobs
│  └─ app/                   placeholder UI + API route stubs
├─ runner/                PowerShell 7 executor (central runner / client agent)
│  ├─ Start-IamRunner.ps1    poll/claim/execute/report loop
│  ├─ modules/               Coretelligent.M365 (reference) + future modules
│  └─ lib/                   Coretelligent.Secrets, Coretelligent.ServiceNow
└─ profiles/              v2 client profiles (seed source) + _schema.json
```

## The one decision worth knowing up front

Cloud systems are driven by a central runner calling their APIs. On-prem systems (AD,
file servers, appliances) are driven by a lightweight agent installed in the client's
network that polls this app over outbound HTTPS — no inbound firewall changes. Browser
automation is a last-resort executor inside a runner, never the transport. Both runner
types execute the same `Coretelligent.*` PowerShell modules, so there is one execution
path. Full rationale in `docs/ARCHITECTURE.md`.

## Getting started (Phase 1)

```bash
cd web
npm install
# set DATABASE_URL in .env to a Postgres instance
npm run db:migrate
npm run db:seed     # loads the five seeded profiles
npm run dev
```

Then build the clients list with add/archive per `docs/BUILD_PLAN.md`.
