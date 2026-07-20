# JML completion roadmap — the top 10 features to "done"

**Date:** 2026-07-20
**Status:** Roadmap spec (portfolio). Each of the 10 is scoped here for prioritization; each then gets its own
spec → plan → build cycle. This is not a single implementation plan.

## Goal & lens

Make iam-engine a **complete** joiner/mover/leaver automation platform for the Remote-Support MSP org
(~200–500 client tenants). "Complete" is defined by the user as **zero manual escapes**: an operator never has
to leave the app mid-case (no spreadsheet, no vendor portal, no side-channel), at fleet scale.

The 10 are ranked by **(manual escape eliminated) × (closeness-to-done)** and collectively span coverage,
fleet-scale operations, governance/compliance, and intake. Each item is tagged:

- **Status:** `Built-core` (a tested core exists, needs wiring/UI) · `Specced` (design exists) · `Planned`
  (in `docs/modules/_BUILD_PLAN.md` or a roadmap note) · `Partial` (some infra exists) · `New`.
- **Effort:** S / M / L (relative).
- 🌐 = a fleet-wide tool (not just per-case).

## What's already built (the baseline these extend)

Onboard / offboard / **change-mover** cases; ~30 directory + SaaS executors (AD, Entra/M365, Exchange, Google,
Mimecast, Adobe, Spanning, Zoom, Slack, 1Password, KnowBe4, Perimeter81, Egnyte, HubSpot, Jira…); the low-code
**connector builder** (http/browser); ad-hoc access grants; password reset; seat-aware licensing; MFA cleanup;
mailbox/OneDrive/SharePoint delegate grants; the **fleet permission audit** + **readiness** views; guided
credential setup; and the **M365 app-registration auto-setup** provisioning core (PR #126, Phases 1–4 core).
The runner protocol, credential broker (Delinea), audit log + ServiceNow work-notes, and `requiresApproval`
gating are all in place. The 10 below are the remaining gaps to "no manual escapes."

---

## The top 10

### 1. Finish M365 auto-setup — end-to-end + fleet run 🌐
**Escape killed:** wiring each client's M365 app-registration credential by hand (the #1 client-setup
bottleneck). **Status:** Built-core (PR #126: provision + device-code GA auth + Delinea write-back +
`setupM365ForClient` orchestration core, all unit-tested). **Effort:** M.
**Scope:** build the live-validated remainder specced in `2026-07-19-m365-auto-setup-phase4-5-design.md` — the
`dispatchDeviceCodeJob` real impl (synthetic CaseRequest + entra-devicecode Job), the `startRun`-style detached
run + a `M365SetupRun`/`M365SetupRunClient` progress table (migration), a per-client "Set up M365 automatically"
button (device user-code + progress + WARN reasons), and the fleet sweep (E5) with per-client skip
(no `m365-global-admin` secret / non-automatable MFA), dry-run, a runtime cap, and a mutating-sweep permission
gate. **Blocking dependency:** one live smoke-test on a real tenant + GA(TOTP) before fleet rollout. **Closest
to done → build first.**

### 2. Write the unwritten vendor modules
**Escape killed:** Teams Phone, AVD, MDM (Addigy/Jamf/Intune), Dropbox, Notion, Printix JML steps drop to a
manual checklist for every client that uses them. **Status:** Planned (`docs/modules/_BUILD_PLAN.md` has each
one's steps, permissions, and exact Delinea `FieldReq[]` template). **Effort:** L (per module; parallelizable).
**Scope:** per the build-plan — hand-written modules for the stateful/bespoke ones (Teams 3-way writeback, AVD
host-pool logic, MDM vendor-switch with wipe-approval), connector-builder definitions for the REST-CRUD ones
(Dropbox, Notion), and a group-membership executor for Printix. **Blocking dependency (operator inputs):** each
vendor's Secret Server numeric `templateId` (`DELINEA_TEMPLATE_<KEY>`), API base URL/scopes, and (for
connectors) a HAR capture. Sequence by client volume; ship one vendor at a time behind its own tests.

### 3. Offboard data-transfer
**Escape killed:** manually transferring a leaver's mailbox / OneDrive / Google Drive / file-share data to their
manager before the account is deleted — today a manual step with real data-loss risk. **Status:** Planned
(cross-cutting; calls existing per-module transfer primitives). **Effort:** M.
**Scope:** a first-class offboard step `dataTransfer` with a target (manager/UPN) that fans into per-system
transfer actions (EXO mailbox → shared/delegate, OneDrive → delegate/handoff, Google Drive transfer API, file
shares) with `requiresApproval` + `captureEvidence`, ordered BEFORE any destructive delete/archive. Reuses the
mailbox-mirror / OneDrive-delegate machinery already built.

### 4. Scheduled / future-dated JML 🌐
**Escape killed:** tracking future events (a joiner's start date, a leaver's last day, a seasonal/acquisition
wave) in a spreadsheet and remembering to run them. **Status:** Partial (`sweepScheduledCases` release infra
exists; the creation/scheduling surface is missing). **Effort:** M.
**Scope:** a `scheduledFor` on a case + a UI to future-date any JML case (single or bulk), a daily release sweep
that promotes due cases to active, pre-flight validation at schedule time, and reminders. Composes with #5.

### 5. Bulk JML (CSV / multi-select) 🌐
**Escape killed:** mass onboard/offboard/mover for acquisitions, RIFs, seasonal — done one-at-a-time or in a
spreadsheet today. **Status:** Specced (roadmap #3 in the change-mover flagship spec). **Effort:** M.
**Scope:** one action → N cases (upload a CSV or multi-select), an **aggregate preview** (per-user adds/removes,
exceptions surfaced), per-user failure isolation, and a batch run view. Reuses the change-case diff engine and
the one-user-per-case model (fan-out, not a new case type).

### 6. Two-way ServiceNow
**Escape killed:** a case currently **starts and ends outside the app** — the intake form is transcribed by
hand, and the ticket is closed/annotated manually. **Status:** Partial (work-notes are written one-way).
**Effort:** M.
**Scope:** auto-**create** the case from a ServiceNow intake (the `DATA_MODEL.md` SN mapping already exists for
the fields), and auto-**close/annotate** the ticket + sync case status transitions back to SN on completion or
failure. A polling/webhook intake + a status-sync writer. Closes the loop end-to-end.

### 7. Offboard completeness verification + auto-remediation
**Escape killed:** manually confirming a leaver is *truly gone across every system* — the
"unlicensed-user-invisible-downstream" class where a missed system leaves a live account. **Status:** Partial
(run-report + verify jobs exist, but no per-case guarantee). **Effort:** M.
**Scope:** after an offboard, a **verification pass** that re-reads each targeted system for residual
access/license/session and **re-queues misses** (idempotent, bounded retries), turning "we ran the steps" into
"we confirmed the outcome." Surfaces a green/amber/red per-case completeness verdict; a fleet view of
incomplete offboards feeds #8.

### 8. Access drift detection & reconciliation 🌐
**Escape killed:** manually spot-checking whether *actual* access still matches *intended* — grants made
outside the engine, incomplete offboards, orphaned/leaked seats. **Status:** New (the leaked-seats audit is
read-only precedent). **Effort:** L.
**Scope:** a scheduled fleet **reconciler** that diffs each user's live memberships/licenses against the
engine's intended state (persona/location/global rules) and reports drift, with a one-click remediate (open a
change case). Folds in **license/seat reclamation** (reclaim unused/leaver seats → cost). Reuses the
change-case diff engine over the whole fleet.

### 9. Access reviews / recertification 🌐
**Escape killed:** periodic "who has access to what," done in spreadsheets for audits. **Status:** New.
**Effort:** L.
**Scope:** scheduled **recertification campaigns** — snapshot each user's access, route to their manager (or an
approver) to attest, **revoke-on-non-attest** (opens a change case), and produce an **exportable evidence
pack**. The compliance leg a complete JML tool needs; reuses the approval gate + change-case machinery.

### 10. First-class manual-step management
**Escape killed:** the steps that genuinely can't be automated (no API) are a bare checkbox today, so an
operator works them **off-app** with no tracking. **Status:** Partial (manual `mode` steps are recorded as
checklist items). **Effort:** M.
**Scope:** make a manual step a fully **managed unit in the app** — assign to a person, due-date + **SLA**,
reminders, **evidence capture** (paste a confirmation / attach a screenshot), and completion that flows into the
case's audit trail. This is what makes "an unmodeled step" stop being an escape even when it can't be automated.

---

## Tier 2 — captured, not in the 10 (fast-follows)

- **Case undo/rollback** — one-click restore of a mistaken offboard (`priorStatus` stamps already exist; make
  them a real restore). Small, high-safety.
- **Deferred archive-then-delete worker** — the 30–90-day post-offboard archive step (needs the same due-date
  worker as #4).
- **Runner/agent fleet health dashboard** 🌐 — agents up/down, versions, capabilities, stuck-job detection.
- **Reporting / SLA analytics + audit-evidence export** 🌐 — case volume, time-to-complete, SLA adherence.
- **Self-service manager portal** — managers file/track JML requests directly (deeper than #6's SN intake).

## Suggested build sequence

1. **#1 (finish M365 auto-setup)** — closest to done, highest single-escape leverage; needs the live smoke-test.
2. **#3 (data-transfer)** + **#7 (offboard verification)** — complete the offboard path (both reuse existing
   machinery; verification makes every offboard trustworthy).
3. **#4 (scheduled) + #5 (bulk)** — the fleet-scale case-creation pair (share the diff engine + a due-date
   worker that #10-Tier2-archive also needs).
4. **#2 (vendor modules)** — parallel track, gated on operator inputs; ship one vendor at a time by volume.
5. **#6 (two-way ServiceNow)** — closes the intake/closure loop once the case surfaces are solid.
6. **#8 (drift/reconciliation) → #9 (access reviews)** — the governance layer, built on the change-case diff
   engine and the approval gate.
7. **#10 (manual-step management)** — cross-cutting; can slot in early since it improves every case that still
   has a manual step.

## Cross-cutting notes

- **Reuse over rebuild:** #3/#5/#8/#9 all lean on the existing **change-case diff engine** and per-module
  executors; #4 + Tier-2-archive share ONE due-date worker; #7/#8 share the "re-read live state" reader.
- **The async model:** long-running fleet operations (#1 fleet, #8, #9) reuse the `startRun` detached-run +
  progress-row + stale-after pattern (`web/lib/audits/audit-runs.ts`) — there is no queue/worker; that is the
  house pattern.
- **Live validation:** #1 (browser/tenant), #2 (vendor APIs/tenants), #3 (data APIs) each need an operator
  live-validation pass before fleet rollout — build with mocked deps + unit tests, then validate one client.
- **Every item** follows the house rules: idempotent executors; `requiresApproval` on destructive/removing
  steps; an `AuditLog` row + ServiceNow work-note per job; a changelog entry per commit; runner `VERSION` bump
  on runner changes.
- **Not widening scope:** stays within the JML domain and the already-chosen backbones (entra / ad-synced,
  Google, Mimecast); PGLS and the parked clients remain out.
