# Build plan

Phased so each phase is shippable and de-risks the next. Volume-weighted: the top-20
clients (highest case count) come first, and they're almost all `entra` or `ad` backbone,
already documented — so the early phases hit real throughput fast.

## Phase 1 — Brain + data (no runners yet)

- Stand up Postgres + Prisma; run the schema.
- `prisma/seed.ts`: ingest `profiles/*.json` into `Client` / `ClientSystem` / `Secret`,
  and seed `SystemCatalog` from the system keys (set `buildTier`: 1 for built/core
  modules, 3 for long tail).
- Clients UI: list, detail (show its modules + which are manual), add a client (create +
  default system rows = "onboard a client"), archive a client (status = archived).
- Acceptance: the five seeded profiles (six-one, regal, yuma, marketscience, raith) render
  with their per-system config and manual flags; you can add and archive a client.

## Phase 2 — Case intake + planning

- `CaseRequest` create from a payload matching the ServiceNow intake forms (DATA_MODEL).
- Orchestrator (`web/lib/orchestrator.ts`): expand a case into `Job` rows — filter by
  lane/`on-request`, topo-sort by `dependsOn`, mark `manual`/`browser` as checklist items.
- Case UI: submit/view a case, see the planned step list, the manual checklist, status.
- Acceptance: submitting an onboard case for a seeded client produces the correct ordered
  job list with manual steps flagged — still without executing anything.

## Phase 3 — Cloud runner (execute for real, M365 first)

- Implement the runner poll/claim/result loop (`runner/Start-IamRunner.ps1`).
- Wire `m365` jobs to the existing `Coretelligent.M365` module (already idempotent).
- Credential brokering from Delinea (reuse `Coretelligent.Secrets`); ServiceNow work-note
  write-back (reuse `Coretelligent.ServiceNow`).
- Acceptance: an onboard case for an `entra` top-20 client provisions M365 end to end,
  with audit + work note, and is safe to re-run.

## Phase 4 — Client-network agent + Active Directory

- Agent enrollment, mTLS, per-client job scoping.
- Build `Coretelligent.ActiveDirectory` (create/sync onboard; the evidence-capture +
  disable/guardrail offboard path). This is the highest-leverage tier-2 module (3 top-20
  clients) and exercises create-plus-sync and the offboard guardrails.
- Acceptance: an onboard + an offboard case for an `ad-synced` top-20 client (e.g. Six One)
  run through the agent, including `Start-ADSyncSyncCycle` and evidence capture.

## Phase 5 — Long tail + browser fallback

- Add the high-frequency modules surfaced by the corpus analysis, in rough order:
  Mimecast (near-core), Adobe, Google Workspace, KnowBe4, SharePoint, Spanning, Zoom,
  Slack, MDM (Addigy/Jamf/Intune), Proofpoint, Dropbox, Egnyte.
- Playwright fallback inside the agent for API-less systems (Egnyte Sync Server, printer
  address books).
- Acceptance: a top-20 client with a long-tail system (e.g. Brighton Park / Google, or a
  Spanning client) completes without manual steps beyond the genuinely-manual ones.

## Phase 6 — Fleet onboarding (the generator)

- Build the KB parser that converts the ServiceNow KB exports into draft profiles, scoped
  to in-scope (rated 1/2/3) clients, emitting a confidence flag and a "systems detected
  but not yet modeled" report. Auto-covers ~80–86% of the book; the rest are flagged.
- Apply the CVP and Olympus templates across their respective practice families.

## Parked / out of scope (don't pull in without asking)

PGLS (ignore). Institute On Aging is offboard-only. Boys & Girls Club (no offboard doc)
and Atlanta Opera (doc needs cleanup) wait on doc fixes. "Needs Cleanup / Document
Missing / N/A" clients are deferred.
